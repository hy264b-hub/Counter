(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 1) 소스 태깅: GENERATION_STARTED payload 기반 (가장 안정적)
  // =========================
  let lastApiType = "";   // "copilot" | "google" | "other" | ""
  let lastApiTime = 0;

  // 스트리밍/후처리 지연 고려: 120초
  const API_WINDOW_MS = 120 * 1000;

  function setApiType(type) {
    lastApiType = type;
    lastApiTime = Date.now();
  }

  function isRecentCopilot() {
    const elapsed = Date.now() - lastApiTime;
    return lastApiType === "copilot" && elapsed < API_WINDOW_MS;
  }

  function detectFromAny(objOrText) {
    let s = "";
    try {
      s = (typeof objOrText === "string" ? objOrText : JSON.stringify(objOrText)).toLowerCase();
    } catch (_) {
      s = "";
    }
    if (!s) return "";

    // ✅ Copilot(4141) 우선
    if (
      s.includes("localhost:4141") ||
      s.includes("127.0.0.1:4141") ||
      s.includes("0.0.0.0:4141") ||
      s.includes(":4141/v1") ||
      s.includes("localhost:4141/v1")
    ) return "copilot";

    // ✅ Google
    if (
      s.includes("generativelanguage.googleapis.com") ||
      s.includes("gemini") ||
      s.includes("ai studio") ||
      s.includes("google")
    ) return "google";

    // 그 외
    return "other";
  }

  // =========================
  // 2) 저장/설정
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
        debug: { lastEvent: "", lastApiType: "", lastCheck: "" }
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (typeof s.lastSig !== "string") s.lastSig = "";
    if (!s.debug) s.debug = { lastEvent: "", lastApiType: "", lastCheck: "" };
    return s;
  }

  function save() {
    getCtx().saveSettingsDebounced();
  }

  // =========================
  // 3) 메시지 파싱
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
    return (
      msg.is_error === true ||
      msg.error === true ||
      (typeof msg.error === "string" && msg.error.trim().length > 0) ||
      msg.type === "error" ||
      msg.status === "error"
    );
  }

  function signatureFromMessage(msg) {
    const text = getMsgText(msg).trim();
    const time = String(msg?.send_date || msg?.created || msg?.id || "");
    return `${time}|${text.slice(0, 80)}`;
  }

  // =========================
  // 4) UI
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
          display:none; position:fixed; inset:0;
          background:rgba(0,0,0,0.7); z-index:10000;
          align-items:center; justify-content:center;
        }
        #${OVERLAY_ID}[data-open="1"]{display:flex;}
        #ccModal{background:#1e1e1e;border-radius:16px;width:90%;max-width:500px;max-height:80vh;overflow:auto;box-shadow:0 8px 32px rgba(0,0,0,0.4);}
        #ccModal header{padding:20px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;}
        #ccModal .title{font-size:1.3em;font-weight:600;}
        #ccModal .body{padding:20px;}
        .ccCards{display:flex;gap:12px;margin-bottom:24px;}
        .ccCard{flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:16px;text-align:center;}
        .ccLabel{font-size:0.85em;opacity:0.7;margin-bottom:8px;}
        .ccValue{font-size:2em;font-weight:700;}
        .ccSmall{font-size:0.75em;opacity:0.6;margin-top:4px;}
        #ccBars{background:rgba(255,255,255,0.03);border-radius:12px;padding:16px;margin-bottom:16px;}
        .barsTitle{display:flex;justify-content:space-between;margin-bottom:12px;font-size:0.9em;}
        .ccBarRow{display:flex;align-items:center;gap:8px;margin-bottom:8px;}
        .ccBarDate{width:50px;font-size:0.85em;opacity:0.7;}
        .ccBarTrack{flex:1;height:24px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;}
        .ccBarFill{height:100%;background:linear-gradient(90deg,#4a9eff,#6b5fff);transition:width 0.3s ease;}
        .ccBarNum{width:30px;text-align:right;font-size:0.85em;font-weight:600;}
        #ccModal footer{padding:16px 20px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:8px;justify-content:flex-end;}
        .ccBtn{padding:8px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:white;cursor:pointer;font-size:0.9em;}
        .ccBtn:hover{background:rgba(255,255,255,0.15);}
        .ccBtn.danger{background:rgba(220,38,38,0.2);border-color:rgba(220,38,38,0.4);}
        .ccBtn.danger:hover{background:rgba(220,38,38,0.3);}
      </style>

      <div id="ccModal" role="dialog" aria-modal="true">
        <header>
          <div class="title">🤖 Copilot Counter</div>
          <button class="ccBtn" id="ccCloseBtn" type="button">✕</button>
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

          <!-- 필요 없으면 이 블록 통째로 삭제해도 됨 -->
          <div class="ccSmall" id="ccDebugLine" style="opacity:.6; font-family:monospace;"></div>
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
      const elapsed = lastApiTime ? (Date.now() - lastApiTime) : -1;
      dbg.textContent = `src=${lastApiType || "-"} / elapsed=${elapsed}ms / window=${API_WINDOW_MS}ms / lastEvent=${s.debug.lastEvent || "-"}`;
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
    item.addEventListener("click", (e) => { e.stopPropagation(); openDashboard(); });
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
    s.debug.lastEvent = eventName;

    // ✅ Copilot일 때만 카운트
    if (!isRecentCopilot()) {
      save();
      return;
    }

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
    // ended에서는 카운트만 시도 (태깅은 started에서 함)
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

  function onGenStarted(payload) {
    // ✅ 여기서 “이번 생성 소스”를 태깅
    const tag = detectFromAny(payload);
    setApiType(tag || "other");
  }

  function main() {
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    if (event_types?.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, onGenStarted);
    if (event_types?.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types?.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    if (event_types?.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
  }

  main();
})();
