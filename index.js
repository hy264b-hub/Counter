(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";
  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 유틸
  // =========================
  const NEEDLE_4141 = /localhost:4141|127\.0\.0\.1:4141|0\.0\.0\.0:4141|:4141\b|:4141\/v1/i;

  function nowStr() { return new Date().toLocaleTimeString("ko-KR"); }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  }

  // =========================
  // 저장값 (LOCK 모드)
  // =========================
  // lockMode:
  //  - "auto": 4141 감지될 때만 집계
  //  - "on"  : 무조건 집계
  //  - "off" : 무조건 집계 안 함
  function getSettings() {
    const { extensionSettings } = getCtx();
    if (!extensionSettings[MODULE]) {
      extensionSettings[MODULE] = {
        total: 0,
        byDay: {},
        lastSig: "",
        lockMode: "auto",
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (typeof s.lastSig !== "string") s.lastSig = "";
    if (!["auto","on","off"].includes(s.lockMode)) s.lockMode = "auto";
    return s;
  }
  function save() { getCtx().saveSettingsDebounced(); }

  function todayKeyLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  }

  // =========================
  // 로그
  // =========================
  const logs = [];
  const MAX_LOGS = 150;
  function addLog(msg) {
    logs.unshift(`[${nowStr()}] ${msg}`);
    if (logs.length > MAX_LOGS) logs.pop();
    const el = document.getElementById("ccLogs");
    if (el) el.innerHTML = logs.map(l => `<div>${escapeHtml(l)}</div>`).join("");
  }

  // =========================
  // Copilot 토큰 큐 (덮어쓰기 방지)
  // =========================
  const COPILOT_QUEUE_MS = 2 * 60 * 1000;
  const copilotQueue = []; // [{at, why, url}]

  function pruneQueue() {
    const now = Date.now();
    while (copilotQueue.length && (now - copilotQueue[copilotQueue.length - 1].at) > COPILOT_QUEUE_MS) {
      copilotQueue.pop();
    }
  }

  function pushCopilotToken(why, url) {
    copilotQueue.unshift({ at: Date.now(), why, url: url || "" });
    pruneQueue();
    addLog(`🏷️ copilot token +1 (${why}) queue=${copilotQueue.length}`);
  }

  function consumeCopilotToken() {
    pruneQueue();
    if (!copilotQueue.length) return null;
    return copilotQueue.shift();
  }

  // =========================
  // fetch/XHR 후킹: "4141 감지"만으로 토큰 생성
  // =========================
  function looksGen(url, bodyText) {
    return /chat|completion|messages|generate/i.test(url || "") ||
           /"messages"\s*:|"prompt"\s*:|"model"\s*:/.test(bodyText || "");
  }

  (function hookFetch() {
    if (window.__ccFetchHooked_toggle) return;
    window.__ccFetchHooked_toggle = true;

    const origFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      try {
        const input = args[0];
        const init = args[1] || {};

        let url = "";
        if (typeof input === "string") url = input;
        else if (input && typeof input.url === "string") url = input.url;

        let bodyText = "";
        if (init?.body != null) {
          if (typeof init.body === "string") bodyText = init.body;
          else if (typeof init.body === "object" && !(init.body instanceof FormData)) {
            try { bodyText = JSON.stringify(init.body); } catch {}
          }
        }
        if (!bodyText && input instanceof Request) {
          try {
            const t = await input.clone().text();
            if (t && t.trim()) bodyText = t;
          } catch {}
        }

        if (looksGen(url, bodyText) && NEEDLE_4141.test(`${url}\n${bodyText}`)) {
          pushCopilotToken("needle_4141_in_url_or_body", url);
        }
      } catch {}
      return origFetch(...args);
    };

    addLog("✅ fetch hook ON");
  })();

  (function hookXHR() {
    if (window.__ccXHRHooked_toggle) return;
    window.__ccXHRHooked_toggle = true;

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
      this.__ccUrl = url || "";
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function(body) {
      try {
        const url = this.__ccUrl || "";
        let bodyText = "";
        if (typeof body === "string") bodyText = body;
        else if (body && typeof body === "object" && !(body instanceof FormData)) {
          try { bodyText = JSON.stringify(body); } catch {}
        }

        if (looksGen(url, bodyText) && NEEDLE_4141.test(`${url}\n${bodyText}`)) {
          pushCopilotToken("needle_4141_in_url_or_body", url);
        }
      } catch {}
      return origSend.call(this, body);
    };

    addLog("✅ XHR hook ON");
  })();

  // =========================
  // 메시지 파싱/중복 방지
  // =========================
  function getMsgText(msg) {
    if (!msg) return "";
    const cands = [msg.mes, msg.message, msg.content, msg.text, msg?.data?.mes, msg?.data?.content, msg?.data?.message];
    return cands.find(v => typeof v === "string") ?? "";
  }
  function isErrorLike(msg) {
    if (!msg) return false;
    return msg.is_error === true || msg.error === true || msg.type === "error" || msg.status === "error";
  }
  function signatureFromMessage(msg) {
    const text = getMsgText(msg).trim();
    const time =
      (typeof msg?.send_date === "number" ? String(msg.send_date) : "") ||
      (typeof msg?.created === "number" ? String(msg.created) : "") ||
      (typeof msg?.id === "string" ? msg.id : "");
    return `${time}|${text.slice(0, 80)}`;
  }
  function lastAssistant(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      const isAssistant =
        (m?.is_user === false) || (m?.is_user === "false") ||
        (m?.role === "assistant") || (m?.sender === "assistant");
      if (isAssistant) return m;
    }
    return null;
  }

  // =========================
  // 카운트
  // =========================
  function increment() {
    const s = getSettings();
    const t = todayKeyLocal();
    s.total += 1;
    s.byDay[t] = (s.byDay[t] ?? 0) + 1;
    save();
    addLog(`✅ COUNT +1 (today=${s.byDay[t]}, total=${s.total})`);
    if (document.getElementById(OVERLAY_ID)?.getAttribute("data-open") === "1") renderDashboard();
  }

  // LOCK 로직
  function shouldCountNow() {
    const s = getSettings();
    if (s.lockMode === "on") return { ok: true, why: "LOCK=ON" };
    if (s.lockMode === "off") return { ok: false, why: "LOCK=OFF" };

    // AUTO
    const token = consumeCopilotToken();
    if (!token) return { ok: false, why: "AUTO(no token)" };
    return { ok: true, why: `AUTO(token:${token.why})` };
  }

  function tryCountFromLastAssistant(eventName) {
    addLog(`📨 ${eventName}`);

    const decision = shouldCountNow();
    if (!decision.ok) {
      addLog(`❌ skip (${decision.why}) queue=${copilotQueue.length}`);
      return;
    }
    addLog(`✅ pass (${decision.why}) queue=${copilotQueue.length}`);

    const c = getCtx();
    const msg = lastAssistant(c.chat ?? []);
    if (!msg) { addLog("❌ no assistant msg"); return; }
    if (isErrorLike(msg)) { addLog("❌ error msg"); return; }

    const text = getMsgText(msg);
    if (!text.trim()) { addLog("❌ empty msg"); return; }

    const s = getSettings();
    const sig = signatureFromMessage(msg);
    if (!sig || sig === "none|") { addLog("❌ bad sig"); return; }
    if (s.lastSig === sig) { addLog("❌ dup msg"); return; }

    s.lastSig = sig;
    increment();
  }

  // =========================
  // UI
  // =========================
  function lastNDaysKeysLocal(n=7) {
    const out = [];
    const base = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(base);
      d.setDate(base.getDate() - i);
      out.push(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`);
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
        #${OVERLAY_ID}{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:10000;align-items:center;justify-content:center;padding:10px;}
        #${OVERLAY_ID}[data-open="1"]{display:flex;}
        #ccModal{background:#1e1e1e;border-radius:16px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);}
        #ccModal header{padding:16px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#1e1e1e;}
        #ccModal .title{font-size:1.2em;font-weight:600;}
        #ccModal .body{padding:16px;}
        .ccCards{display:flex;gap:10px;margin-bottom:16px;}
        .ccCard{flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:12px;text-align:center;}
        .ccLabel{font-size:0.8em;opacity:0.7;margin-bottom:6px;}
        .ccValue{font-size:1.8em;font-weight:700;}
        .ccSmall{font-size:0.7em;opacity:0.6;margin-top:4px;}
        .ccRow{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px;}
        .ccBtn{padding:8px 12px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:white;cursor:pointer;font-size:0.85em;white-space:nowrap;}
        .ccBtn.primary{background:rgba(59,130,246,0.35);border-color:rgba(59,130,246,0.6);}
        .ccBtn.danger{background:rgba(220,38,38,0.2);border-color:rgba(220,38,38,0.4);}
        #ccLogs{background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px;max-height:320px;overflow-y:auto;font-family:monospace;font-size:0.65em;line-height:1.4;}
        #ccLogs div{padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);}
      </style>

      <div id="ccModal" role="dialog" aria-modal="true">
        <header>
          <div class="title">🤖 Copilot Counter</div>
          <button class="ccBtn" id="ccCloseBtn">✕</button>
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
              <div class="ccSmall">Copilot(4141)만</div>
            </div>
          </div>

          <div class="ccRow">
            <button class="ccBtn" id="ccModeAuto">MODE: AUTO</button>
            <button class="ccBtn" id="ccModeOn">LOCK: ON</button>
            <button class="ccBtn" id="ccModeOff">LOCK: OFF</button>
            <div style="opacity:.75;font-size:.85em;align-self:center;">
              현재: <span id="ccModeLabel" style="font-weight:700;">-</span> /
              queue=<span id="ccQueueLabel" style="font-weight:700;">0</span>
            </div>
          </div>

          <div class="ccRow">
            <button class="ccBtn danger" id="ccResetBtn">전체 리셋</button>
            <button class="ccBtn" id="ccClearLog">로그 지우기</button>
          </div>

          <div id="ccLogs">로그 대기 중...</div>
        </div>

        <footer style="padding:12px 16px;border-top:1px solid rgba(255,255,255,0.1);display:flex;justify-content:flex-end;">
          <button class="ccBtn" id="ccCloseBtn2">닫기</button>
        </footer>
      </div>
    `;

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDashboard(); });
    document.body.appendChild(overlay);

    document.getElementById("ccCloseBtn").addEventListener("click", closeDashboard);
    document.getElementById("ccCloseBtn2").addEventListener("click", closeDashboard);

    document.getElementById("ccModeAuto").addEventListener("click", () => {
      const s = getSettings(); s.lockMode = "auto"; save();
      addLog("🔁 mode = AUTO");
      renderDashboard();
    });
    document.getElementById("ccModeOn").addEventListener("click", () => {
      const s = getSettings(); s.lockMode = "on"; save();
      addLog("🔒 LOCK = ON (무조건 집계)");
      renderDashboard();
    });
    document.getElementById("ccModeOff").addEventListener("click", () => {
      const s = getSettings(); s.lockMode = "off"; save();
      addLog("🧊 LOCK = OFF (무조건 미집계)");
      renderDashboard();
    });

    document.getElementById("ccClearLog").addEventListener("click", () => {
      logs.length = 0;
      addLog("🧹 logs cleared");
      renderDashboard();
    });

    document.getElementById("ccResetBtn").addEventListener("click", () => {
      if (!confirm("전체 데이터를 리셋할까요?")) return;
      const s = getSettings();
      s.total = 0; s.byDay = {}; s.lastSig = "";
      save();
      copilotQueue.length = 0;
      logs.length = 0;
      addLog("🗑️ reset done");
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

    pruneQueue();
    document.getElementById("ccModeLabel").textContent = s.lockMode.toUpperCase();
    document.getElementById("ccQueueLabel").textContent = String(copilotQueue.length);

    const el = document.getElementById("ccLogs");
    if (el) el.innerHTML = logs.length ? logs.map(l => `<div>${escapeHtml(l)}</div>`).join("") : "로그 대기 중...";
  }

  // =========================
  // 메뉴 주입
  // =========================
  function findWandMenuContainer() {
    const selectors = [
      "#extensions_menu",
      "#extensionsMenu",
      ".extensions_menu",
      ".extensions-menu",
      ".dropdown-menu"
    ];
    for (const sel of selectors) {
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
    item.style.cssText =
      "padding:10px 12px;cursor:pointer;user-select:none;border-radius:10px;margin:4px 6px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);";
    item.textContent = "🤖 Copilot Counter";
    item.addEventListener("click", (e) => { e.stopPropagation(); openDashboard(); });
    menu.appendChild(item);
    addLog("✅ menu injected");
    return true;
  }

  function observeForMenu() {
    const mo = new MutationObserver(() => injectWandMenuItem());
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // =========================
  // 이벤트 훅
  // =========================
  function onGenEnded() { tryCountFromLastAssistant("GENERATION_ENDED"); }
  function onCharacterRendered() { tryCountFromLastAssistant("CHARACTER_MESSAGE_RENDERED"); }
  function onMessageReceived() { tryCountFromLastAssistant("MESSAGE_RECEIVED"); }

  function main() {
    addLog("🚀 Copilot Counter boot (AUTO + LOCK)");
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();
    if (event_types?.GENERATION_ENDED) { eventSource.on(event_types.GENERATION_ENDED, onGenEnded); addLog("✓ hook: GENERATION_ENDED"); }
    if (event_types?.CHARACTER_MESSAGE_RENDERED) { eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered); addLog("✓ hook: CHARACTER_MESSAGE_RENDERED"); }
    if (event_types?.MESSAGE_RECEIVED) { eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived); addLog("✓ hook: MESSAGE_RECEIVED"); }

    addLog("✅ init done");
  }

  main();
})();
