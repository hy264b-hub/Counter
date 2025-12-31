(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 단순화된 감지: 마지막 요청 타입만 추적
  // =========================
  let lastApiType = "";
  let lastApiTime = 0;
  const API_WINDOW_MS = 10 * 1000; // 10초

  function setApiType(type) {
    lastApiType = type;
    lastApiTime = Date.now();
    console.log(`[CopilotCounter] API 타입 설정: ${type}`);
  }

  function isRecentCopilot() {
    const elapsed = Date.now() - lastApiTime;
    const result = lastApiType === "copilot" && elapsed < API_WINDOW_MS;
    console.log(`[CopilotCounter] Copilot 체크: type=${lastApiType}, elapsed=${elapsed}ms, result=${result}`);
    return result;
  }

  // URL과 본문에서 API 타입 감지
  function detectFromText(text) {
    if (!text) return "";
    const lower = text.toLowerCase();

    // Copilot (localhost:4141)
    if (lower.includes("localhost:4141") || 
        lower.includes("127.0.0.1:4141") || 
        lower.includes(":4141")) {
      return "copilot";
    }

    // Google AI Studio
    if (lower.includes("generativelanguage.googleapis.com") ||
        lower.includes("google") ||
        lower.includes("gemini")) {
      return "google";
    }

    return "";
  }

  // =========================
  // XMLHttpRequest 후킹 추가
  // =========================
  (function hookXHR() {
    if (window.__ccXHRHooked) return;
    window.__ccXHRHooked = true;

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__ccUrl = url;
      console.log(`[CopilotCounter] XHR open: ${url}`);
      
      const type = detectFromText(url);
      if (type) setApiType(type);
      
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      if (body) {
        console.log(`[CopilotCounter] XHR send body:`, body);
        const type = detectFromText(body);
        if (type) setApiType(type);
      }
      
      const type = detectFromText(this.__ccUrl);
      if (type) setApiType(type);
      
      return origSend.call(this, body);
    };
  })();

  // =========================
  // Fetch 후킹
  // =========================
  (function hookFetch() {
    if (window.__ccFetchHooked) return;
    window.__ccFetchHooked = true;

    const origFetch = window.fetch;

    window.fetch = async function(...args) {
      try {
        const input = args[0];
        const init = args[1] || {};

        // URL 체크
        let url = "";
        if (typeof input === "string") {
          url = input;
        } else if (input?.url) {
          url = input.url;
        }

        console.log(`[CopilotCounter] Fetch URL: ${url}`);
        let type = detectFromText(url);
        if (type) setApiType(type);

        // Body 체크
        if (init.body) {
          const bodyStr = typeof init.body === "string" ? init.body : JSON.stringify(init.body);
          console.log(`[CopilotCounter] Fetch body:`, bodyStr.slice(0, 200));
          const bodyType = detectFromText(bodyStr);
          if (bodyType) setApiType(bodyType);
        }
      } catch (err) {
        console.error("[CopilotCounter] Fetch hook error:", err);
      }

      return origFetch.apply(this, args);
    };
  })();

  // =========================
  // 저장/설정
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
          lastCheck: ""
        }
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (!s.debug) s.debug = { lastEvent: "", lastApiType: "", lastCheck: "" };
    return s;
  }

  function save() {
    getCtx().saveSettingsDebounced();
  }

  // =========================
  // 메시지 파싱
  // =========================
  function getMsgText(msg) {
    if (!msg) return "";
    const candidates = [
      msg.mes,
      msg.message,
      msg.content,
      msg.text,
      msg?.data?.mes,
      msg?.data?.content
    ];
    return candidates.find(v => typeof v === "string") ?? "";
  }

  function isErrorLike(msg) {
    if (!msg) return false;
    return msg.is_error === true || 
           msg.error === true || 
           (typeof msg.error === "string" && msg.error.trim().length > 0);
  }

  function signatureFromMessage(msg) {
    const text = getMsgText(msg).trim();
    const time = String(msg?.send_date || msg?.created || msg?.id || "");
    return `${time}|${text.slice(0, 80)}`;
  }

  // =========================
  // UI
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
        .ccDebugBox {
          background: rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.1);
          border-radius: 8px;
          padding: 12px;
          font-family: monospace;
          font-size: 0.8em;
          line-height: 1.6;
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
              <div class="ccSmall">Copilot만</div>
            </div>
          </div>

          <div id="ccBars">
            <div class="barsTitle">
              <div class="left">최근 7일</div>
              <div class="right" id="ccBarsHint">—</div>
            </div>
            <div id="ccBarsList"></div>
          </div>

          <div class="ccDebugBox" id="ccDebugBox">
            <div><strong>디버그 정보:</strong></div>
            <div id="ccDebugLine">—</div>
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
      s.debug = { lastEvent: "", lastApiType: "", lastCheck: "" };
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
      const elapsed = Date.now() - lastApiTime;
      dbg.innerHTML = `
        마지막 API: <strong>${lastApiType || "없음"}</strong><br>
        경과 시간: ${elapsed}ms (${API_WINDOW_MS}ms 이내여야 함)<br>
        마지막 이벤트: ${s.debug.lastEvent || "-"}<br>
        마지막 체크: ${s.debug.lastCheck || "-"}
      `;
    }
  }

  // =========================
  // 메뉴
  // =========================
  function findWandMenuContainer() {
    const candidates = [
      "#extensions_menu",
      "#extensionsMenu",
      ".extensions_menu"
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
    console.log(`[CopilotCounter] ✅ 카운트 증가: 오늘=${s.byDay[t]}, 전체=${s.total}`);
    save();

    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  function tryCountFromMessage(msg, eventName) {
    console.log(`[CopilotCounter] 이벤트: ${eventName}`);
    
    const s = getSettings();
    s.debug.lastEvent = eventName;

    const isCopilot = isRecentCopilot();
    s.debug.lastApiType = lastApiType || "없음";
    s.debug.lastCheck = `${isCopilot ? "✅ Copilot" : "❌ 아님"} (${Date.now() - lastApiTime}ms 전)`;
    
    if (!isCopilot) {
      console.log(`[CopilotCounter] ❌ Copilot 아님: ${lastApiType}`);
      save();
      return;
    }

    const isAssistant =
      (msg?.is_user === false) ||
      (msg?.role === "assistant") ||
      (msg?.sender === "assistant");

    if (!isAssistant) {
      console.log("[CopilotCounter] ❌ 어시스턴트 메시지 아님");
      return;
    }

    if (isErrorLike(msg)) {
      console.log("[CopilotCounter] ❌ 에러 메시지");
      return;
    }

    const text = getMsgText(msg);
    if (text.trim().length === 0) {
      console.log("[CopilotCounter] ❌ 빈 메시지");
      return;
    }

    const sig = signatureFromMessage(msg);
    if (!sig || sig === "none|") {
      console.log("[CopilotCounter] ❌ 잘못된 시그니처");
      return;
    }

    if (s.lastSig === sig) {
      console.log("[CopilotCounter] ❌ 중복 메시지");
      return;
    }

    s.lastSig = sig;
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

    if (event_types?.MESSAGE_RECEIVED) {
      eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    }
    if (event_types?.CHARACTER_MESSAGE_RENDERED) {
      eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    }
    if (event_types?.GENERATION_ENDED) {
      eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
    }

    console.log("[CopilotCounter] ✅ 초기화 완료 - XHR + Fetch 후킹 활성화");
  }

  main();
})();
