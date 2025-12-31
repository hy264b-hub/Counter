(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";
  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 로그
  // =========================
  const logs = [];
  const MAX_LOGS = 60;
  function addLog(msg) {
    const time = new Date().toLocaleTimeString("ko-KR");
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > MAX_LOGS) logs.pop();
    const el = document.getElementById("ccLogs");
    if (el) el.innerHTML = logs.map(l => `<div>${l}</div>`).join("");
  }
  function norm(s){ return (typeof s === "string" ? s : "").trim(); }

  // =========================
  // Copilot(4141) 판별
  // =========================
  function is4141(url) {
    const s = (url || "").toLowerCase();
    return (
      s.includes("localhost:4141") ||
      s.includes("127.0.0.1:4141") ||
      s.includes("0.0.0.0:4141") ||
      s.includes(":4141/") ||
      s.endsWith(":4141")
    );
  }

  // =========================
  // 1) 활성 소스(src) 확정 (여기가 제일 중요)
  // - "google인데도 src가 other"가 나오는 케이스가 있어서
  //   후보를 최대한 넓게 잡고, '가장 googleish한' 값을 우선한다.
  // =========================
  function getActiveSourceStrict() {
    const c = getCtx();

    const rawCandidates = [
      c?.settings?.chat_completion_source,
      c?.chat_completion_source,
      c?.settings?.main_api,
      c?.main_api,
      c?.settings?.api_source,
      c?.api_source,
      c?.settings?.chatCompletionSource,
      c?.chatCompletionSource,
      c?.settings?.chatCompletionSetting?.source,
      c?.settings?.chatCompletionSetting?.selectedSource,
      c?.settings?.chatCompletionSetting?.activeSource,
      c?.chatCompletionSetting?.source,
      c?.chatCompletionSetting?.selectedSource,
    ].map(norm).filter(Boolean);

    // 로그에 후보를 다 보여줌 (원인 파악용)
    addLog(`src 후보: ${rawCandidates.length ? rawCandidates.join(" | ") : "(없음)"}`);

    const lower = rawCandidates.map(v => v.toLowerCase());

    // google/gemini가 하나라도 있으면 그걸로 확정
    const googleHit = lower.find(v => v.includes("google") || v.includes("gemini") || v.includes("ai studio") || v.includes("aistudio"));
    if (googleHit) return googleHit;

    // openrouter도 우선 확정
    const orHit = lower.find(v => v.includes("openrouter"));
    if (orHit) return orHit;

    // openai 계열
    const oaiHit = lower.find(v => v.includes("openai") || v.includes("openai-compatible") || v.includes("chat completion") || v.includes("custom") || v.includes("oai"));
    if (oaiHit) return oaiHit;

    // fallback: 첫 번째라도 반환
    return lower[0] || "";
  }

  // =========================
  // 2) "활성 소스별" endpoint만 읽기 (blob 전체 검색 금지)
  //
  // - 핵심: settings.chatCompletionSetting 전체에서 찾지 않는다.
  // - 대신, '소스별 settings 슬롯'에서만 본다.
  // =========================
  function pickFirstUrl(obj, keys = []) {
    if (!obj || typeof obj !== "object") return "";
    // 명시 키 우선
    for (const k of keys) {
      const v = norm(obj?.[k]);
      if (v) return v;
    }
    // fallback: 흔한 키들
    const fallbackKeys = ["api_url","apiUrl","base_url","baseUrl","endpoint","proxy_url","proxyUrl","host"];
    for (const k of fallbackKeys) {
      const v = norm(obj?.[k]);
      if (v) return v;
    }
    return "";
  }

  function getEndpointForActiveSourceStrict(src) {
    const c = getCtx();
    const s = c?.settings || {};

    // Google은 endpoint로 판정 안 함 (오탐 방지)
    if (src.includes("google") || src.includes("gemini") || src.includes("ai studio") || src.includes("aistudio")) {
      return { url: "", where: "src=google (endpoint ignored)" };
    }

    // 1) 소스별 settings 슬롯 후보들
    //    (SillyTavern 버전/확장마다 이름이 다름 → 폭넓게)
    const slots = [];

    // OpenAI 계열(너의 Copilot이 여기로 붙어 있음)
    slots.push({ where: "settings.openai_settings", obj: s.openai_settings });
    slots.push({ where: "settings.oai_settings", obj: s.oai_settings });
    slots.push({ where: "ctx.openai_settings", obj: c.openai_settings });
    slots.push({ where: "ctx.oai_settings", obj: c.oai_settings });

    // Custom/OpenAI-compatible 쪽에서 endpoint를 따로 저장하는 케이스
    slots.push({ where: "settings.custom_endpoint", obj: s.custom_endpoint });
    slots.push({ where: "settings.customEndpoint", obj: s.customEndpoint });

    // chatCompletionSetting은 "전체 blob"이지만,
    // 여기서는 "활성 소스에 해당하는 하위 슬롯"만 있으면 그것만 읽는다.
    // (예: chatCompletionSetting.openai / chatCompletionSetting.custom / chatCompletionSetting.sources[src] 같은 구조)
    const ccs = s.chatCompletionSetting || c.chatCompletionSetting;
    if (ccs && typeof ccs === "object") {
      // 하위 슬롯 후보들 (존재할 때만)
      if (ccs.openai) slots.push({ where: "chatCompletionSetting.openai", obj: ccs.openai });
      if (ccs.custom) slots.push({ where: "chatCompletionSetting.custom", obj: ccs.custom });
      if (ccs.openai_compatible) slots.push({ where: "chatCompletionSetting.openai_compatible", obj: ccs.openai_compatible });
      if (ccs.openaiCompatible) slots.push({ where: "chatCompletionSetting.openaiCompatible", obj: ccs.openaiCompatible });

      // sources 맵 형태
      if (ccs.sources && typeof ccs.sources === "object") {
        // src 키로 직접 접근 시도
        const k = Object.keys(ccs.sources).find(k => k.toLowerCase() === src.toLowerCase());
        if (k) slots.push({ where: `chatCompletionSetting.sources["${k}"]`, obj: ccs.sources[k] });
      }

      // profiles/entries 배열 형태(각 항목에 source/name이 있음)
      const arr = ccs.profiles || ccs.entries || ccs.items || ccs.list;
      if (Array.isArray(arr)) {
        const hit = arr.find(x => {
          const v = norm(x?.source || x?.name || x?.id).toLowerCase();
          return v && (v === src || v.includes(src));
        });
        if (hit) slots.push({ where: "chatCompletionSetting.(profiles hit)", obj: hit });
      }
    }

    // 2) 슬롯들에서 url 뽑기
    const tried = [];
    for (const slot of slots) {
      if (!slot?.obj) continue;
      const url = pickFirstUrl(slot.obj);
      if (url) {
        tried.push(`${slot.where} -> ${url}`);
        return { url: url.toLowerCase(), where: slot.where, tried };
      }
      tried.push(`${slot.where} -> (no url)`);
    }

    return { url: "", where: "no-endpoint-found", tried };
  }

  // =========================
  // 3) 최종 판정
  // =========================
  function analyzeCopilotNow() {
    const src = getActiveSourceStrict();
    addLog(`📌 활성 src = ${src || "(없음)"}`);

    // Google/Gemini/OpenRouter는 무조건 Copilot 금지 (여기서 끝)
    if (src.includes("google") || src.includes("gemini") || src.includes("ai studio") || src.includes("aistudio")) {
      addLog("❌ src=Google/Gemini → Copilot 금지");
      return { isCopilot: false, reason: `source=${src}`, source: src, endpoint: "" };
    }
    if (src.includes("openrouter")) {
      addLog("❌ src=OpenRouter → Copilot 금지");
      return { isCopilot: false, reason: `source=${src}`, source: src, endpoint: "" };
    }

    // endpoint는 '활성 소스 슬롯'에서만 읽는다
    const ep = getEndpointForActiveSourceStrict(src);
    addLog(`🔗 endpoint = ${ep.url || "(없음)"}  [${ep.where}]`);
    if (ep.tried?.length) addLog(`endpoint 탐색: ${ep.tried.slice(0, 3).join(" | ")}${ep.tried.length > 3 ? " ..." : ""}`);

    // OpenAI 계열만 Copilot 후보
    const isOpenAIish =
      src.includes("openai") ||
      src.includes("openai-compatible") ||
      src.includes("chat completion") ||
      src.includes("custom") ||
      src.includes("oai") ||
      src === "" ||
      src === "other";

    if (!isOpenAIish) {
      addLog("❌ OpenAI 계열 아님 → Copilot 금지");
      return { isCopilot: false, reason: `not_openaiish_source=${src}`, source: src, endpoint: ep.url || "" };
    }

    if (is4141(ep.url)) {
      addLog("✅ Copilot 확정: (OpenAI 계열 + 4141)");
      return { isCopilot: true, reason: `openaiish+4141(${ep.where})`, source: src, endpoint: ep.url };
    }

    addLog("❌ OpenAI 계열이지만 endpoint가 4141이 아님");
    return { isCopilot: false, reason: "openaiish_but_not_4141", source: src, endpoint: ep.url || "" };
  }

  // =========================
  // generation 태깅
  // =========================
  let lastGen = { isCopilot: false, startedAt: 0, source: "", endpoint: "", reason: "" };
  const GEN_WINDOW_MS = 5 * 60 * 1000;

  function tagGenerationStart() {
    addLog("🚀 GENERATION_STARTED → 판정");
    const r = analyzeCopilotNow();
    lastGen = { isCopilot: r.isCopilot, startedAt: Date.now(), source: r.source || "", endpoint: r.endpoint || "", reason: r.reason || "" };
    addLog(r.isCopilot ? "🏷️ 태그=Copilot" : `🏷️ 태그=NOT (${r.reason})`);
  }

  function isThisGenCopilot() {
    return lastGen.isCopilot && (Date.now() - lastGen.startedAt) < GEN_WINDOW_MS;
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
    if (!extensionSettings[MODULE]) extensionSettings[MODULE] = { total: 0, byDay: {}, lastSig: "" };
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (typeof s.lastSig !== "string") s.lastSig = "";
    return s;
  }
  function save() { getCtx().saveSettingsDebounced(); }

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
    return (msg.is_error === true || msg.error === true || (typeof msg.error === "string" && msg.error.trim().length > 0) || msg.type === "error" || msg.status === "error");
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
        #ccModal{background:#1e1e1e;border-radius:16px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);}
        #ccModal header{padding:16px;border-bottom:1px solid rgba(255,255,255,0.1);display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;background:#1e1e1e;}
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
        #ccLogs{background:rgba(0,0,0,0.4);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px;max-height:320px;overflow-y:auto;font-family:monospace;font-size:0.65em;line-height:1.4;}
        #ccLogs div{padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.03);}
        #ccModal footer{padding:12px 16px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:#1e1e1e;flex-wrap:wrap;}
        .ccBtn{padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:white;cursor:pointer;font-size:0.85em;white-space:nowrap;}
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
              <div class="ccSmall">Copilot(4141)만</div>
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
            <div class="ccSectionTitle"><span>📊 현재 Generation 상태</span><span id="ccGenStatus" style="font-size:0.85em;opacity:0.8;">—</span></div>
            <div id="ccStatus">
              <div><div style="opacity:0.7;margin-bottom:4px;">소스</div><div id="ccSrc" style="font-weight:600;">-</div></div>
              <div><div style="opacity:0.7;margin-bottom:4px;">엔드포인트(탐지)</div><div id="ccEndpoint" style="font-weight:600;">-</div></div>
              <div><div style="opacity:0.7;margin-bottom:4px;">판정 이유</div><div id="ccReason" style="font-weight:600;">-</div></div>
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
          <button class="ccBtn primary" id="ccScanBtn">🔍 수동 스캔</button>
          <button class="ccBtn" id="ccCloseBtn2">닫기</button>
        </footer>
      </div>
    `;

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDashboard(); });
    document.body.appendChild(overlay);

    document.getElementById("ccCloseBtn").addEventListener("click", closeDashboard);
    document.getElementById("ccCloseBtn2").addEventListener("click", closeDashboard);

    document.getElementById("ccClearLog").addEventListener("click", () => {
      logs.length = 0;
      addLog("🗑️ 로그 지움");
    });

    document.getElementById("ccScanBtn").addEventListener("click", () => {
      addLog("🔄 수동 스캔");
      tagGenerationStart();
      renderDashboard();
    });

    document.getElementById("ccResetBtn").addEventListener("click", () => {
      if (!confirm("전체 데이터를 리셋할까요?")) return;
      const s = getSettings();
      s.total = 0; s.byDay = {}; s.lastSig = "";
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
        </div>`;
    });
    document.getElementById("ccBarsHint").textContent = `max ${max}`;

    const elapsed = lastGen.startedAt ? Math.floor((Date.now() - lastGen.startedAt) / 1000) : 0;
    document.getElementById("ccGenStatus").textContent = lastGen.isCopilot ? `✅ Copilot (${elapsed}s)` : `❌ 아님 (${elapsed}s)`;
    document.getElementById("ccSrc").textContent = lastGen.source || "-";
    document.getElementById("ccEndpoint").textContent = lastGen.endpoint || "-";
    document.getElementById("ccReason").textContent = lastGen.reason || "-";

    const el = document.getElementById("ccLogs");
    if (el && logs.length > 0) el.innerHTML = logs.map(l => `<div>${l}</div>`).join("");
  }

  // =========================
  // 메뉴
  // =========================
  function findWandMenuContainer() {
    return (
      document.querySelector("#extensions_menu") ||
      document.querySelector("#extensionsMenu") ||
      document.querySelector(".extensions_menu") ||
      document.querySelector(".extensions-menu") ||
      document.querySelector(".dropdown-menu")
    );
  }

  function injectWandMenuItem() {
    const menu = findWandMenuContainer();
    if (!menu || menu.querySelector(`#${MENU_ITEM_ID}`)) return;

    const item = document.createElement("div");
    item.id = MENU_ITEM_ID;
    item.style.cssText =
      "padding:10px 12px;cursor:pointer;user-select:none;border-radius:10px;margin:4px 6px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);";
    item.textContent = "🤖 Copilot Counter";
    item.addEventListener("click", (e) => { e.stopPropagation(); openDashboard(); });
    menu.appendChild(item);
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
    if (document.getElementById(OVERLAY_ID)?.getAttribute("data-open") === "1") renderDashboard();
  }

  function tryCountFromLastAssistant(eventName) {
    addLog(`📨 ${eventName}`);

    if (!isThisGenCopilot()) {
      addLog("❌ Copilot gen 아님 → 카운트 안 함");
      return;
    }

    const c = getCtx();
    const msg = lastAssistant(c.chat ?? []);
    if (!msg) { addLog("❌ 어시스턴트 메시지 없음"); return; }
    if (isErrorLike(msg)) { addLog("❌ 에러 메시지"); return; }

    const text = getMsgText(msg);
    if (!text.trim()) { addLog("❌ 빈 메시지"); return; }

    const s = getSettings();
    const sig = signatureFromMessage(msg);
    if (s.lastSig === sig) { addLog("❌ 중복 메시지"); return; }

    s.lastSig = sig;
    increment();
  }

  function onGenStarted() {
    tagGenerationStart();
    if (document.getElementById(OVERLAY_ID)?.getAttribute("data-open") === "1") renderDashboard();
  }
  function onGenEnded() { tryCountFromLastAssistant("GENERATION_ENDED"); }
  function onCharacterRendered() { tryCountFromLastAssistant("CHARACTER_MESSAGE_RENDERED"); }
  function onMessageReceived() { tryCountFromLastAssistant("MESSAGE_RECEIVED"); }

  function main() {
    addLog("🚀 Copilot Counter 시작");
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();
    if (event_types?.GENERATION_STARTED) { eventSource.on(event_types.GENERATION_STARTED, onGenStarted); addLog("✓ hook: GENERATION_STARTED"); }
    if (event_types?.GENERATION_ENDED) { eventSource.on(event_types.GENERATION_ENDED, onGenEnded); addLog("✓ hook: GENERATION_ENDED"); }
    if (event_types?.CHARACTER_MESSAGE_RENDERED) { eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered); addLog("✓ hook: CHARACTER_MESSAGE_RENDERED"); }
    if (event_types?.MESSAGE_RECEIVED) { eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived); addLog("✓ hook: MESSAGE_RECEIVED"); }
    addLog("✅ 초기화 완료");
  }

  main();
})();
