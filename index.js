(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 요청 단에서 "이번 생성이 Copilot인지" 태깅하기 (Request까지 읽는 버전)
  // =========================
  let lastRequestTag = "";     // "copilot" | "google" | "other" | ""
  let lastRequestAt = 0;
  const TAG_WINDOW_MS = 2 * 60 * 1000; // 2분

  function setTag(tag) {
    lastRequestTag = tag;
    lastRequestAt = Date.now();
  }

  function tagFromBodyText(t) {
    const s = (t || "").toLowerCase();

    // ✅ Google 우선(구글 흔적 있으면 무조건 google)
    if (s.includes("google") || s.includes("gemini") || s.includes("ai studio")) return "google";

    // ✅ Copilot(4141) 흔적 있으면 copilot
    if (
      s.includes("localhost:4141") ||
      s.includes("127.0.0.1:4141") ||
      s.includes("0.0.0.0:4141") ||
      s.includes(":4141/v1") ||
      s.includes("localhost:4141/v1") ||
      s.includes("127.0.0.1:4141/v1") ||
      s.includes("0.0.0.0:4141/v1")
    ) return "copilot";

    // OpenAI-ish 흔적은 other로만(4141 없으면 copilot 확정 불가)
    if (
      s.includes("openai") ||
      s.includes("openai-compatible") ||
      s.includes("openai compatible") ||
      s.includes("chat completion") ||
      s.includes("chat_completion_source")
    ) return "other";

    return "";
  }

  (function hookFetchForTagging() {
    if (window.__ccTaggedFetchHooked_v2) return;
    window.__ccTaggedFetchHooked_v2 = true;

    const origFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
      try {
        const input = args[0];
        const init = args[1] || {};

        // 1) URL에서도 단서가 있을 수 있음
        const url =
          (typeof input === "string" && input) ||
          (input && typeof input.url === "string" && input.url) ||
          "";
        if (typeof url === "string" && url) {
          const tag = tagFromBodyText(url);
          if (tag) setTag(tag);
        }

        // 2) init.body가 string인 경우
        const body = init?.body;
        if (typeof body === "string") {
          const tag = tagFromBodyText(body);
          if (tag) setTag(tag);
        } else if (body && typeof body === "object" && !(body instanceof FormData)) {
          try {
            const txt = JSON.stringify(body);
            const tag = tagFromBodyText(txt);
            if (tag) setTag(tag);
          } catch (_) {}
        }

        // 3) ✅ 핵심: input이 Request 객체인 경우 → clone().text()로 body 읽기
        if (input instanceof Request) {
          input.clone().text().then((txt) => {
            const tag = tagFromBodyText(txt);
            if (tag) setTag(tag);
          }).catch(() => {});
        }
      } catch (_) {}

      return origFetch(...args);
    };
  })();

  function isRecentCopilotRequest() {
    if (!lastRequestTag) return false;
    if ((Date.now() - lastRequestAt) > TAG_WINDOW_MS) return false;
    return lastRequestTag === "copilot";
  }

  // =========================
  // 2) 날짜/저장
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
          lastCopilotDetect: "",
        }
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (typeof s.lastSig !== "string") s.lastSig = "";
    if (!s.debug) s.debug = { lastEvent: "", lastCopilotDetect: "" };
    return s;
  }

  function save() {
    getCtx().saveSettingsDebounced();
  }

  // =========================
  // 3) 메시지 파싱/유효성
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
  // 4) UI (대시보드)
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
      <div id="ccModal" role="dialog" aria-modal="true">
        <header>
          <div class="title">Copilot Counter</div>
          <button class="xbtn" id="ccCloseBtn" type="button">닫기</button>
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
              <div class="ccSmall">빈 응답/오류 제외</div>
            </div>
          </div>

          <div id="ccBars">
            <div class="barsTitle">
              <div class="left">최근 7일</div>
              <div class="right" id="ccBarsHint">—</div>
            </div>
            <div id="ccBarsList"></div>
          </div>

          <!-- 디버그: 필요 없으면 UI에서만 보이게 놔둬도 됨 -->
          <div class="ccCard" style="padding:10px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)">
            <div class="ccLabel">상태</div>
            <div class="ccSmall" id="ccDebugLine">—</div>
          </div>
        </div>

        <footer>
          <button class="ccBtn danger" id="ccResetBtn" type="button">리셋</button>
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
      s.debug = { lastEvent: "", lastCopilotDetect: "" };
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
      // 태깅 상태를 간단히 노출(원하면 나중에 제거 가능)
      dbg.textContent = `tag=${lastRequestTag || "-"} / age=${lastRequestAt ? (Math.floor((Date.now()-lastRequestAt)/1000)+"s") : "-"}`;
    }
  }

  // =========================
  // 5) 메뉴 주입
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
    item.style.padding = "8px 10px";
    item.style.cursor = "pointer";
    item.style.userSelect = "none";
    item.style.borderRadius = "10px";
    item.style.margin = "4px 6px";
    item.style.border = "1px solid rgba(255,255,255,.10)";
    item.style.background = "rgba(255,255,255,.04)";
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
  // 6) 집계
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
    save();

    // ✅ Copilot 요청의 결과일 때만 카운트
    if (!isRecentCopilotRequest()) return;

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

    increment();
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
  }

  main();
})();
