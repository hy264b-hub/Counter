(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 로그 시스템
  // =========================
  const logs = [];
  const MAX_LOGS = 40;

  function addLog(msg) {
    const time = new Date().toLocaleTimeString('ko-KR');
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > MAX_LOGS) logs.pop();

    const logEl = document.getElementById("ccLogs");
    if (logEl) {
      logEl.innerHTML = logs.map(l => `<div>${l}</div>`).join('');
      logEl.scrollTop = 0;
    }
  }

  // =========================
  // ✅ 엄격한 "현재 활성" 소스/엔드포인트 읽기
  // - 전체 스캔으로 ':4141' 흔적을 주워오면 오탐이 나서 금지
  // - '현재 선택된 provider'가 google이면 무조건 카운트 금지
  // =========================
  function norm(s) {
    return (typeof s === "string" ? s : "").trim();
  }

  function getActiveSourceStrict() {
    const c = getCtx();

    const candidates = [
      c?.settings?.main_api,
      c?.main_api,
      c?.settings?.chat_completion_source,
      c?.chat_completion_source,
      c?.settings?.api_source,
      c?.api_source,
    ].map(norm).filter(Boolean);

    if (candidates.length) return candidates[0].toLowerCase();

    // DOM select fallback(설정 UI가 열려있을 때만)
    try {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const val = norm(sel?.value).toLowerCase();
        if (
          val.includes("openai") ||
          val.includes("google") ||
          val.includes("gemini") ||
          val.includes("openrouter") ||
          val.includes("anthropic") ||
          val.includes("claude")
        ) return val;
      }
    } catch (_) {}

    return "";
  }

  function getOpenAIEndpointStrict() {
    const c = getCtx();

    const candidates = [
      c?.openai_settings?.base_url,
      c?.openai_settings?.api_url,
      c?.oai_settings?.base_url,
      c?.oai_settings?.api_url,
      c?.settings?.api_url,
      c?.settings?.base_url,
      c?.api_url,
      c?.base_url,
    ].map(norm).filter(Boolean);

    if (candidates.length) return candidates[0].toLowerCase();

    // DOM input fallback (설정 UI가 열려있을 때만)
    try {
      const inputs = Array.from(document.querySelectorAll("input"));
      for (const el of inputs) {
        const v = norm(el?.value).toLowerCase();
        if (!v) continue;
        const looksLikeUrl = v.startsWith("http://") || v.startsWith("https://");
        if (!looksLikeUrl) continue;
        if (v.includes("/v1") || v.includes("localhost") || v.includes("127.0.0.1")) return v;
      }
    } catch (_) {}

    return "";
  }

  function is4141Endpoint(endpoint) {
    const ep = (endpoint || "").toLowerCase();
    return (
      ep.includes("localhost:4141") ||
      ep.includes("127.0.0.1:4141") ||
      ep.includes("0.0.0.0:4141") ||
      ep.includes(":4141/")
    );
  }

  // =========================
  // ✅ "Copilot인지" 판정: 오탐 방지 버전
  // =========================
  function analyzeCopilotStrict() {
    addLog("🔍 Copilot 분석(엄격) 시작...");

    const src = getActiveSourceStrict();
    const ep = getOpenAIEndpointStrict();

    addLog(`📌 활성 소스: ${src || "(없음)"}`);
    addLog(`🔗 OpenAI endpoint: ${ep || "(없음)"}`);

    const isGoogle =
      src.includes("google") ||
      src.includes("gemini") ||
      src.includes("ai studio") ||
      src === "google" ||
      src === "gemini";

    if (isGoogle) {
      addLog("❌ 현재 소스=Google/Gemini → Copilot 집계 금지");
      return { isCopilot: false, reason: `active_source=${src}`, endpoint: "", source: src };
    }

    const isOpenRouter = src.includes("openrouter");
    if (isOpenRouter) {
      addLog("❌ 현재 소스=OpenRouter → Copilot 집계 금지");
      return { isCopilot: false, reason: `active_source=${src}`, endpoint: "", source: src };
    }

    const isOpenAIish =
      src.includes("openai") ||
      src.includes("openai-compatible") ||
      src.includes("chat completion") ||
      src.includes("custom") ||
      src === ""; // 소스 키를 못 찾는 환경 대비: endpoint로 판정 허용

    if (!isOpenAIish) {
      addLog("❌ 현재 소스가 OpenAI 계열이 아님 → Copilot 집계 금지");
      return { isCopilot: false, reason: `active_source_not_openaiish=${src || "(none)"}`, endpoint: "", source: src };
    }

    if (is4141Endpoint(ep)) {
      addLog("✅ Copilot 확정 (OpenAI 계열 + 4141 endpoint)");
      return { isCopilot: true, reason: "openaiish+endpoint=4141", endpoint: ep, source: src };
    }

    addLog("❌ OpenAI 계열이지만 endpoint가 4141이 아님 → Copilot 아님");
    return { isCopilot: false, reason: "openaiish+endpoint!=4141", endpoint: ep || "", source: src };
  }

  // =========================
  // Generation 태그
  // =========================
  let lastGen = { isCopilot: false, startedAt: 0, source: "", endpoint: "", reason: "" };
  const GEN_WINDOW_MS = 5 * 60 * 1000;

  function tagGenerationStart() {
    const result = analyzeCopilotStrict();

    lastGen = {
      isCopilot: result.isCopilot,
      startedAt: Date.now(),
      source: result.source || "",
      endpoint: result.endpoint || "",
      reason: result.reason || ""
    };

    addLog(result.isCopilot ? "🏷️ Generation: COPILOT" : `🏷️ Generation: ${result.reason}`);
  }

  function isThisGenCopilot() {
    if (!lastGen.isCopilot) return false;
    return (Date.now() - lastGen.startedAt) < GEN_WINDOW_MS;
  }

  // =========================
  // 저장/설정
  // =========================
  function todayKeyLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function getSettings() {
    const { extensionSettings } = getCtx();
    if (!extensionSettings[MODULE]) {
      extensionSettings[MODULE] = { total: 0, byDay: {}, lastSig: "" };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (typeof s.lastSig !== "string") s.lastSig = "";
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
    const candidates = [msg.mes, msg.message, msg.content, msg.text, msg?.data?.mes, msg?.data?.content, msg?.data?.message];
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

  function lastAssistant(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m?.is_user === false) return m;
      if (m?.role === "assistant") return m;
    }
    return null;
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
      out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
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
        #ccModal{background:#1e1e1e;border-radius:16px;width:100%;max-width:600px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);}
        #ccModal header{padding:16px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#1e1e1e;z-index:1;}
        #ccModal .title{font-size:1.2em;font-weight:600;}
        #ccModal .body{padding:16px;}
        .ccCards{display:flex;gap:10px;margin-bottom:16px;}
        .ccCard{flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:12px;text-align:center;}
        .ccLabel{font-size:0.8em;opacity:0.7;margin-bottom:6px;}
        .ccValue{font-size:1.8em;font-weight:700;}
        .ccSmall{font-size:0.7em;opacity:0.6;margin-top:4px;}
        #ccBars{background:rgba(255,255,255,0.03);border-radius:12px;padding:12px;margin-bottom:12px;}
        .barsTitle{display:flex;justify-content:space-between;margin-bottom:10px;font-size:0.85em;}
        .ccBarRow{display:flex;align-items:center;gap:6px;margin-bottom:6px;}
        .ccBarDate{width:45px;font-size:0.75em;opacity:0.7;}
        .ccBarTrack{flex:1;height:20px;background:rgba(255,255,255,0.1);border-radius:4px;overflow:hidden;}
        .ccBarFill{height:100%;background:linear-gradient(90deg,#4a9eff,#6b5fff);}
        .ccBarNum{width:25px;text-align:right;font-size:0.75em;font-weight:600;}
        .ccSection{background:rgba(255,255,255,0.03);border-radius:12px;padding:12px;margin-bottom:12px;}
        .ccSectionTitle{font-size:0.9em;font-weight:600;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;}
        #ccStatus{display:grid;grid-template-columns:1fr;gap:8px;font-size:0.75em;margin-bottom:8px;}
        #ccStatus div{padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;word-break:break-all;}
        #ccLogs{background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px;max-height:300px;overflow-y:auto;font-family:monospace;font-size:0.65em;line-height:1.4;}
        #ccLogs div{padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);}
        #ccModal footer{padding:12px 16px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:#1e1e1e;flex-wrap:wrap;}
        .ccBtn{padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:white;cursor:pointer;font-size:0.85em;white-space:nowrap;}
        .ccBtn:active{background:rgba(255,255,255,0.2);}
        .ccBtn.danger{background:rgba(220,38,38,0.2);border-color:rgba(220,38,38,0.4);}
        .ccBtn.primary{background:rgba(59,130,246,0.3);border-color:rgba(59,130,246,0.5);}
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
              <div class="ccSmall">Copilot만</div>
            </div>
          </div>

          <div id="ccBars">
            <div class="barsTitle">
              <div>최근 7일</div>
              <div id="ccBarsHint">—</div>
            </div>
            <div id="ccBarsList"></div>
          </div>

          <div class="ccSection">
            <div class="ccSectionTitle">
              <span>📊 현재 Generation 상태</span>
              <span id="ccGenStatus" style="font-size:0.85em;opacity:0.8;">—</span>
            </div>
            <div id="ccStatus">
              <div>
                <div style="opacity:0.7;margin-bottom:4px;">소스</div>
                <div id="ccSrc" style="font-weight:600;">-</div>
              </div>
              <div>
                <div style="opacity:0.7;margin-bottom:4px;">엔드포인트</div>
                <div id="ccEndpoint" style="font-weight:600;">-</div>
              </div>
              <div>
                <div style="opacity:0.7;margin-bottom:4px;">판정 이유</div>
                <div id="ccReason" style="font-weight:600;">-</div>
              </div>
            </div>
          </div>

          <div class="ccSection">
            <div class="ccSectionTitle">
              <span>📋 실시간 로그</span>
              <button class="ccBtn" id="ccClearLog" style="font-size:0.75em;padding:4px 8px;">지우기</button>
            </div>
            <div id="ccLogs">로그 대기 중...</div>
          </div>
        </div>

        <footer>
          <button class="ccBtn danger" id="ccResetBtn">전체 리셋</button>
          <button class="ccBtn primary" id="ccScanBtn">🔍 스캔</button>
          <button class="ccBtn" id="ccCloseBtn2">닫기</button>
        </footer>
      </div>
    `;

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDashboard(); });

    document.body.appendChild(overlay);

    document.getElementById("ccCloseBtn")?.addEventListener("click", closeDashboard);
    document.getElementById("ccCloseBtn2")?.addEventListener("click", closeDashboard);

    document.getElementById("ccClearLog")?.addEventListener("click", () => {
      logs.length = 0;
      addLog("🗑️ 로그 지움");
    });

    document.getElementById("ccScanBtn")?.addEventListener("click", () => {
      addLog("🔄 수동 스캔 시작");
      tagGenerationStart();
      renderDashboard();
    });

    document.getElementById("ccResetBtn")?.addEventListener("click", () => {
      if (!confirm("전체 데이터를 리셋할까요?")) return;
      const s = getSettings();
      s.total = 0;
      s.byDay = {};
      s.lastSig = "";
      save();
      logs.length = 0;
      addLog("🗑️ 리셋 완료");
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
      list.innerHTML += `
        <div class="ccBarRow">
          <div class="ccBarDate">${k.slice(5)}</div>
          <div class="ccBarTrack"><div class="ccBarFill" style="width:${pct}%"></div></div>
          <div class="ccBarNum">${v}</div>
        </div>
      `;
    });

    document.getElementById("ccBarsHint").textContent = `max ${max}`;

    const elapsed = lastGen.startedAt ? Math.floor((Date.now() - lastGen.startedAt) / 1000) : 0;
    document.getElementById("ccGenStatus").textContent =
      lastGen.isCopilot ? `✅ Copilot (${elapsed}초 전)` : `❌ 아님 (${elapsed}초 전)`;
    document.getElementById("ccSrc").textContent = lastGen.source || "-";
    document.getElementById("ccEndpoint").textContent = lastGen.endpoint || "-";
    document.getElementById("ccReason").textContent = lastGen.reason || "-";

    const logEl = document.getElementById("ccLogs");
    if (logEl && logs.length > 0) {
      logEl.innerHTML = logs.map(l => `<div>${l}</div>`).join('');
    }
  }

  // =========================
  // 메뉴
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
    item.style.cssText = `padding:10px 12px;cursor:pointer;user-select:none;border-radius:10px;margin:4px 6px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);`;
    item.textContent = "🤖 Copilot Counter";
    item.addEventListener("click", (e) => { e.stopPropagation(); openDashboard(); });
    menu.appendChild(item);

    addLog("🪄 메뉴 주입 완료");
    return true;
  }

  function observeForMenu() {
    new MutationObserver(() => injectWandMenuItem()).observe(document.body, { childList: true, subtree: true });
  }

  // =========================
  // 집계
  // =========================
  function increment() {
    const s = getSettings();
    const t = todayKeyLocal();
    s.total += 1;
    s.byDay[t] = (s.byDay[t] ?? 0) + 1;
    addLog(`✅ 카운트! 오늘=${s.byDay[t]} 전체=${s.total}`);
    save();

    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  function tryCountFromLastAssistant(eventName) {
    addLog(`📨 ${eventName}`);

    if (!isThisGenCopilot()) {
      addLog(`❌ Copilot gen 아님 (${lastGen.reason})`);
      return;
    }

    const c = getCtx();
    const msg = lastAssistant(c.chat ?? []);
    if (!msg) { addLog("❌ 어시스턴트 메시지 없음"); return; }
    if (isErrorLike(msg)) { addLog("❌ 에러"); return; }

    const text = getMsgText(msg);
    if (!text.trim()) { addLog("❌ 빈 메시지"); return; }

    const s = getSettings();
    const sig = signatureFromMessage(msg);
    if (s.lastSig === sig) { addLog("❌ 중복"); return; }

    s.lastSig = sig;
    increment();
  }

  function onGenStarted() {
    addLog("🚀 Generation 시작");
    tagGenerationStart();
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  function onGenEnded() { tryCountFromLastAssistant("GEN_END"); }
  function onCharacterRendered() { tryCountFromLastAssistant("CHAR_RENDER"); }
  function onMessageReceived() { tryCountFromLastAssistant("MSG_RECV"); }

  function main() {
    addLog("🚀 Copilot Counter 시작");

    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    if (event_types?.GENERATION_STARTED) { eventSource.on(event_types.GENERATION_STARTED, onGenStarted); addLog("✓ GENERATION_STARTED"); }
    if (event_types?.GENERATION_ENDED) { eventSource.on(event_types.GENERATION_ENDED, onGenEnded); addLog("✓ GENERATION_ENDED"); }
    if (event_types?.CHARACTER_MESSAGE_RENDERED) { eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered); addLog("✓ CHARACTER_MESSAGE_RENDERED"); }
    if (event_types?.MESSAGE_RECEIVED) { eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived); addLog("✓ MESSAGE_RECEIVED"); }

    addLog("✅ 초기화 완료");
  }

  main();
})();
