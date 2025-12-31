(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 개선된 요청 추적 시스템
  // =========================
  const pendingRequests = new Map(); // requestId -> { tag, timestamp }
  let requestIdCounter = 0;

  function generateRequestId() {
    return `req_${Date.now()}_${++requestIdCounter}`;
  }

  // URL이나 본문에서 Copilot/Google 여부를 더 정확하게 판단
  function detectApiType(url, bodyText) {
    const urlLower = (url || "").toLowerCase();
    const bodyLower = (bodyText || "").toLowerCase();
    const combined = urlLower + " " + bodyLower;

    // 1순위: URL에서 직접 판단 (가장 확실함)
    if (urlLower.includes(":4141")) return "copilot";
    if (urlLower.includes("localhost:4141") || urlLower.includes("127.0.0.1:4141") || urlLower.includes("0.0.0.0:4141")) {
      return "copilot";
    }
    
    if (urlLower.includes("generativelanguage.googleapis.com") || 
        urlLower.includes("ai.google.dev") ||
        urlLower.includes("aistudio.google.com")) {
      return "google";
    }

    // 2순위: 본문에서 판단
    if (bodyLower.includes("localhost:4141") || 
        bodyLower.includes("127.0.0.1:4141") || 
        bodyLower.includes("0.0.0.0:4141") ||
        bodyLower.includes(":4141/v1")) {
      return "copilot";
    }

    if (bodyLower.includes("google") || 
        bodyLower.includes("gemini") || 
        bodyLower.includes("generativelanguage")) {
      return "google";
    }

    // OpenAI-compatible이지만 4141이 아니면 other
    if (bodyLower.includes("openai") || combined.includes("/v1/chat/completions")) {
      return "other";
    }

    return "unknown";
  }

  // Fetch 후킹 - 요청을 추적
  (function hookFetchForTracking() {
    if (window.__ccFetchHooked_v3) return;
    window.__ccFetchHooked_v3 = true;

    const origFetch = window.fetch.bind(window);

    window.fetch = async function(...args) {
      const requestId = generateRequestId();
      let apiType = "unknown";

      try {
        const input = args[0];
        const init = args[1] || {};

        // URL 추출
        let url = "";
        if (typeof input === "string") {
          url = input;
        } else if (input instanceof Request) {
          url = input.url;
        } else if (input?.url) {
          url = input.url;
        }

        // Body 추출 시도 (동기적으로 가능한 것만)
        let bodyText = "";
        if (init?.body) {
          if (typeof init.body === "string") {
            bodyText = init.body;
          } else if (init.body && typeof init.body === "object" && !(init.body instanceof FormData)) {
            try {
              bodyText = JSON.stringify(init.body);
            } catch (_) {}
          }
        }

        // API 타입 감지
        apiType = detectApiType(url, bodyText);

        // 채팅 완성 요청으로 보이는 경우만 추적
        const isChatRequest = 
          url.includes("/chat/completions") || 
          url.includes("/v1/messages") ||
          bodyText.includes("messages") ||
          bodyText.includes("prompt");

        if (isChatRequest && apiType !== "unknown") {
          pendingRequests.set(requestId, {
            tag: apiType,
            timestamp: Date.now(),
            url: url
          });

          // 5분 후 자동 정리
          setTimeout(() => {
            pendingRequests.delete(requestId);
          }, 5 * 60 * 1000);
        }
      } catch (err) {
        console.error("[CopilotCounter] Fetch hook error:", err);
      }

      // 원본 fetch 실행 후 requestId를 응답에 태깅
      const response = await origFetch(...args);
      
      // 응답 객체에 requestId 저장 (나중에 매칭할 수 있도록)
      if (response && pendingRequests.has(requestId)) {
        response.__ccRequestId = requestId;
      }

      return response;
    };
  })();

  // 가장 최근 Copilot 요청인지 확인 (5초 이내)
  function getRecentCopilotRequest() {
    const now = Date.now();
    let mostRecent = null;
    let mostRecentTime = 0;

    for (const [id, data] of pendingRequests.entries()) {
      if (data.tag === "copilot" && (now - data.timestamp) < 5000) {
        if (data.timestamp > mostRecentTime) {
          mostRecent = { id, ...data };
          mostRecentTime = data.timestamp;
        }
      }
    }

    return mostRecent;
  }

  // =========================
  // 날짜/저장
  // =========================
  function todayKeyLocal() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function getSettings() {
    const { extensionSettings } = getCtx();
    if (!extensionSettings[MODULE]) {
      extensionSettings[MODULE] = {
        total: 0,
        byDay: {},
        lastSig: "",
        debug: {
          lastEvent: "",
          lastApiType: "",
          lastTimestamp: ""
        }
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (typeof s.lastSig !== "string") s.lastSig = "";
    if (!s.debug) s.debug = { lastEvent: "", lastApiType: "", lastTimestamp: "" };
    return s;
  }

  function save() {
    getCtx().saveSettingsDebounced();
  }

  // =========================
  // 메시지 파싱/유효성
  // =========================
  function getMsgText(msg) {
    if (!msg) return "";
    const candidates = [
      msg.mes,
      msg.message,
      msg.content,
      msg.text,
      msg?.data?.mes,
      msg?.data?.content,
      msg?.data?.message
    ];
    const t = candidates.find(v => typeof v === "string");
    return t ?? "";
  }

  function isErrorLike(msg) {
    if (!msg) return false;
    if (msg.is_error === true) return true;
    if (msg.error === true) return true;
    if (typeof msg.error === "string" && msg.error.trim().length > 0) return true;
    if (msg.type === "error") return true;
    if (msg.status === "error") return true;
    return false;
  }

  function signatureFromMessage(msg) {
    const text = getMsgText(msg).trim();
    const time =
      (typeof msg?.send_date === "number" ? String(msg.send_date) : "") ||
      (typeof msg?.created === "number" ? String(msg.created) : "") ||
      (typeof msg?.id === "string" ? msg.id : "");
    const head = text.slice(0, 80);
    return `${time}|${head}`;
  }

  // =========================
  // UI (대시보드)
  // =========================
  function lastNDaysKeysLocal(n = 7) {
    const out = [];
    const base = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const day = String(d.getDate()).padStart(2, "0");
      out.push(`${y}-${m}-${day}`);
    }
    return out;
  }

  function ensureDashboard() {
    if (document.getElementById(OVERLAY_ID)) return;

    const overlay = document.createElement("div");
    overlay.id = OVERLAY_ID;
    overlay.setAttribute("data-open", "0");
    overlay.innerHTML = `
      <style>
        #${OVERLAY_ID} {
          display: none;
          position: fixed;
          top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(0,0,0,0.7);
          z-index: 10000;
          align-items: center;
          justify-content: center;
        }
        #${OVERLAY_ID}[data-open="1"] { display: flex; }
        #ccModal {
          background: #1e1e1e;
          border-radius: 16px;
          width: 90%;
          max-width: 500px;
          max-height: 80vh;
          overflow: auto;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4);
        }
        #ccModal header {
          padding: 20px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        #ccModal .title {
          font-size: 1.3em;
          font-weight: 600;
        }
        #ccModal .body {
          padding: 20px;
        }
        .ccCards {
          display: flex;
          gap: 12px;
          margin-bottom: 24px;
        }
        .ccCard {
          flex: 1;
          background: rgba(255,255,255,0.05);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 12px;
          padding: 16px;
          text-align: center;
        }
        .ccLabel {
          font-size: 0.85em;
          opacity: 0.7;
          margin-bottom: 8px;
        }
        .ccValue {
          font-size: 2em;
          font-weight: 700;
        }
        .ccSmall {
          font-size: 0.75em;
          opacity: 0.6;
          margin-top: 4px;
        }
        #ccBars {
          background: rgba(255,255,255,0.03);
          border-radius: 12px;
          padding: 16px;
          margin-bottom: 16px;
        }
        .barsTitle {
          display: flex;
          justify-content: space-between;
          margin-bottom: 12px;
          font-size: 0.9em;
        }
        .ccBarRow {
          display: flex;
          align-items: center;
          gap: 8px;
          margin-bottom: 8px;
        }
        .ccBarDate {
          width: 50px;
          font-size: 0.85em;
          opacity: 0.7;
        }
        .ccBarTrack {
          flex: 1;
          height: 24px;
          background: rgba(255,255,255,0.1);
          border-radius: 4px;
          overflow: hidden;
        }
        .ccBarFill {
          height: 100%;
          background: linear-gradient(90deg, #4a9eff, #6b5fff);
          transition: width 0.3s ease;
        }
        .ccBarNum {
          width: 30px;
          text-align: right;
          font-size: 0.85em;
          font-weight: 600;
        }
        #ccModal footer {
          padding: 16px 20px;
          border-top: 1px solid rgba(255,255,255,0.1);
          display: flex;
          gap: 8px;
          justify-content: flex-end;
        }
        .ccBtn {
          padding: 8px 16px;
          border-radius: 8px;
          border: 1px solid rgba(255,255,255,0.2);
          background: rgba(255,255,255,0.1);
          color: white;
          cursor: pointer;
          font-size: 0.9em;
        }
        .ccBtn:hover {
          background: rgba(255,255,255,0.15);
        }
        .ccBtn.danger {
          background: rgba(220,38,38,0.2);
          border-color: rgba(220,38,38,0.4);
        }
        .ccBtn.danger:hover {
          background: rgba(220,38,38,0.3);
        }
      </style>
      <div id="ccModal" role="dialog" aria-modal="true">
        <header>
          <div class="title">🤖 Copilot Counter</div>
          <button class="xbtn ccBtn" id="ccCloseBtn" type="button">✕</button>
        </header>

        <div class="body">
          <div class="ccCards">
            <div class="ccCard">
              <div class="ccLabel">오늘</div>
              <div class="ccValue" id="ccDashToday">0</div>
              <div class="ccSmall" id="ccDashDate">—</div>
            </div>
            <div class="ccCard">
              <div class="ccLabel">전체</div>
              <div class="ccValue" id="ccDashTotal">0</div>
              <div class="ccSmall">Copilot 응답만</div>
            </div>
          </div>

          <div id="ccBars">
            <div class="barsTitle">
              <div class="left">최근 7일</div>
              <div class="right" id="ccBarsHint">—</div>
            </div>
            <div id="ccBarsList"></div>
          </div>

          <div class="ccCard">
            <div class="ccLabel">디버그 정보</div>
            <div class="ccSmall" id="ccDebugLine" style="font-family: monospace;">—</div>
          </div>
        </div>

        <footer>
          <button class="ccBtn danger" id="ccResetBtn" type="button">전체 리셋</button>
          <button class="ccBtn" id="ccCloseBtn2" type="button">닫기</button>
        </footer>
      </div>
    `;

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) closeDashboard();
    });

    document.body.appendChild(overlay);
    document.getElementById("ccCloseBtn").addEventListener("click", closeDashboard);
    document.getElementById("ccCloseBtn2").addEventListener("click", closeDashboard);

    document.getElementById("ccResetBtn").addEventListener("click", () => {
      if (!confirm("Copilot Counter를 전체 리셋할까요?")) return;
      const s = getSettings();
      s.total = 0;
      s.byDay = {};
      s.lastSig = "";
      s.debug = { lastEvent: "", lastApiType: "", lastTimestamp: "" };
      save();
      renderDashboard();
    });
  }

  function openDashboard() {
    ensureDashboard();
    renderDashboard();
    document.getElementById(OVERLAY_ID)?.setAttribute("data-open", "1");
  }

  function closeDashboard() {
    document.getElementById(OVERLAY_ID)?.setAttribute("data-open", "0");
  }

  function renderDashboard() {
    ensureDashboard();
    const s = getSettings();
    const t = todayKeyLocal();

    document.getElementById("ccDashToday").textContent = String(s.byDay[t] ?? 0);
    document.getElementById("ccDashTotal").textContent = String(s.total ?? 0);
    document.getElementById("ccDashDate").textContent = t;

    const keys = lastNDaysKeysLocal(7);
    const vals = keys.map(k => s.byDay[k] ?? 0);
    const max = Math.max(1, ...vals);

    const list = document.getElementById("ccBarsList");
    list.innerHTML = "";
    keys.forEach((k, idx) => {
      const v = vals[idx];
      const pct = Math.round((v / max) * 100);
      const row = document.createElement("div");
      row.className = "ccBarRow";
      row.innerHTML = `
        <div class="ccBarDate">${k.slice(5)}</div>
        <div class="ccBarTrack"><div class="ccBarFill" style="width:${pct}%"></div></div>
        <div class="ccBarNum">${v}</div>
      `;
      list.appendChild(row);
    });

    document.getElementById("ccBarsHint").textContent = `max ${max}`;

    const dbg = document.getElementById("ccDebugLine");
    if (dbg) {
      const pending = Array.from(pendingRequests.values()).filter(r => r.tag === "copilot");
      dbg.textContent = `추적 중: ${pending.length}개 | 마지막: ${s.debug.lastApiType || "-"} (${s.debug.lastTimestamp || "-"})`;
    }
  }

  // =========================
  // 메뉴 주입
  // =========================
  function findWandMenuContainer() {
    const candidates = [
      "#extensions_menu",
      "#extensionsMenu",
      ".extensions_menu",
      ".extensions-menu",
      ".chatbar_extensions_menu",
      ".chatbar .dropdown-menu",
      ".chat_controls .dropdown-menu",
      ".chat-controls .dropdown-menu",
      ".dropdown-menu"
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  function injectWandMenuItem() {
    const menu = findWandMenuContainer();
    if (!menu) return false;
    if (menu.querySelector(`#${MENU_ITEM_ID}`)) return true;

    const item = document.createElement("div");
    item.id = MENU_ITEM_ID;
    item.style.cssText = `
      padding: 8px 10px;
      cursor: pointer;
      user-select: none;
      border-radius: 10px;
      margin: 4px 6px;
      border: 1px solid rgba(255,255,255,.10);
      background: rgba(255,255,255,.04);
    `;
    item.textContent = "🤖 Copilot Counter";

    item.addEventListener("click", (e) => {
      e.stopPropagation();
      openDashboard();
    });

    menu.appendChild(item);
    return true;
  }

  function observeForMenu() {
    const mo = new MutationObserver(() => injectWandMenuItem());
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // =========================
  // 집계
  // =========================
  function increment() {
    const s = getSettings();
    const t = todayKeyLocal();
    s.total += 1;
    s.byDay[t] = (s.byDay[t] ?? 0) + 1;
    save();

    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  function tryCountFromMessage(msg, eventName) {
    const s = getSettings();
    s.debug.lastEvent = eventName || "";

    // Copilot 요청이 최근에 있었는지 확인
    const recentCopilot = getRecentCopilotRequest();
    if (!recentCopilot) {
      s.debug.lastApiType = "no-copilot-request";
      save();
      return;
    }

    s.debug.lastApiType = "copilot";
    s.debug.lastTimestamp = new Date().toISOString().slice(11, 19);

    const isAssistant =
      (msg?.is_user === false) ||
      (msg?.role === "assistant") ||
      (msg?.sender === "assistant");

    if (!isAssistant) return;
    if (isErrorLike(msg)) return;

    const text = getMsgText(msg);
    if (text.trim().length === 0) return;

    const sig = signatureFromMessage(msg);
    if (!sig || sig === "none|") return;

    if (s.lastSig === sig) return;
    s.lastSig = sig;

    // 사용된 요청 삭제
    pendingRequests.delete(recentCopilot.id);

    increment();
    save();
  }

  function onMessageReceived(data) {
    const msg = data?.message ?? data?.msg ?? data;
    tryCountFromMessage(msg, "MESSAGE_RECEIVED");
  }

  function onCharacterRendered() {
    const c = getCtx();
    const chat = c.chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m?.is_user === false || m?.role === "assistant") {
        tryCountFromMessage(m, "CHARACTER_MESSAGE_RENDERED");
        return;
      }
    }
  }

  function onGenEnded(payload) {
    const c = getCtx();
    const chat = c.chat ?? [];
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m?.is_user === false || m?.role === "assistant") {
        tryCountFromMessage(m, "GENERATION_ENDED");
        return;
      }
    }
  }

  function main() {
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    if (event_types?.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types?.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    if (event_types?.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, onGenEnded);

    console.log("[CopilotCounter] v3 초기화 완료");
  }

  main();
})();
