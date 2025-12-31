(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";
  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 로그
  // =========================
  const logs = [];
  const MAX_LOGS = 50;
  function addLog(msg) {
    const time = new Date().toLocaleTimeString("ko-KR");
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > MAX_LOGS) logs.pop();
    const el = document.getElementById("ccLogs");
    if (el) el.innerHTML = logs.map(l => `<div>${l}</div>`).join("");
  }

  function norm(s) { return (typeof s === "string" ? s : "").trim(); }

  // =========================
  // 1) 활성 소스 읽기(최대 신뢰)
  // =========================
  function getActiveSource() {
    const c = getCtx();
    const candidates = [
      c?.chat_completion_source,
      c?.settings?.chat_completion_source,
      c?.settings?.chatCompletionSource,
      c?.chatCompletionSource,
      c?.settings?.main_api,
      c?.main_api,
      c?.settings?.api_source,
      c?.api_source,
    ];
    const v = candidates.map(norm).find(Boolean);
    if (v) return v.toLowerCase();

    // DOM fallback (설정패널 열렸을 때)
    try {
      for (const sel of document.querySelectorAll("select")) {
        const val = norm(sel.value).toLowerCase();
        if (!val) continue;
        if (val.includes("openai") || val.includes("google") || val.includes("gemini") || val.includes("openrouter") || val.includes("chat")) {
          return val;
        }
      }
    } catch (_) {}
    return "";
  }

  // =========================
  // 2) "활성 소스 설정 덩어리"에서 endpoint 추출
  // - 핵심: openai_settings만 보지 말고, chat completion source 프로필 쪽을 같이 탐색
  // - 단, src가 google이면 바로 컷
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

  // 특정 객체에서 url 후보 키만 뽑기
  function extractUrlCandidates(obj) {
    const out = [];
    if (!obj || typeof obj !== "object") return out;
    const KEY_HINTS = ["endpoint", "base", "url", "host", "proxy"];
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v !== "string") continue;
      const kk = k.toLowerCase();
      const vv = v.trim();
      if (!vv) continue;
      const looksUrl = vv.toLowerCase().startsWith("http://") || vv.toLowerCase().startsWith("https://");
      const keyLooks = KEY_HINTS.some(h => kk.includes(h));
      if (looksUrl || keyLooks || vv.toLowerCase().includes("/v1") || vv.toLowerCase().includes("localhost") || vv.toLowerCase().includes("127.0.0.1")) {
        out.push(vv);
      }
    }
    return out;
  }

  // settings 전체에서 "src 관련 설정 객체"를 찾는다 (src가 들어있는 덩어리만 제한적으로)
  function findConfigBlobsForSource(root, src) {
    const blobs = [];
    const seen = new Set();

    function walk(node, depth, path) {
      if (!node || typeof node !== "object" || depth <= 0) return;
      if (seen.has(node)) return;
      seen.add(node);

      try {
        // 문자열로 대충 stringify해서 src 포함 여부 확인 (너무 깊게 안감)
        let asStr = "";
        try { asStr = JSON.stringify(node); } catch (_) {}
        const hit = asStr && src && asStr.toLowerCase().includes(src);
        const hasUrlish = asStr && (asStr.includes("http") || asStr.includes("/v1") || asStr.includes("endpoint") || asStr.includes("base_url") || asStr.includes("api_url"));

        // "src도 포함 + urlish도 있음"이면 후보 blob
        if (hit && hasUrlish) {
          blobs.push({ path, node });
        }
      } catch (_) {}

      for (const [k, v] of Object.entries(node)) {
        if (v && typeof v === "object") walk(v, depth - 1, path ? `${path}.${k}` : k);
      }
    }

    walk(root, 4, "settings");
    return blobs;
  }

  // src에 해당하는 endpoint를 최대한 "그 src의 blob"에서만 찾는다
  function getEndpointForActiveSource(src) {
    const c = getCtx();
    const settingsRoot = c?.settings || c || {};

    // 1) src 관련 blob 찾기
    const blobs = findConfigBlobsForSource(settingsRoot, src);

    // 2) blob들에서 url 후보 추출 → 4141 우선
    const urls = [];
    for (const b of blobs) {
      const candidates = extractUrlCandidates(b.node);
      candidates.forEach(u => urls.push({ url: u, where: b.path }));
    }

    const hit4141 = urls.find(x => is4141(x.url));
    if (hit4141) return { url: hit4141.url.toLowerCase(), where: `blob:${hit4141.where}` };

    // 3) 그래도 없으면: "chat_completion" 관련 영역을 별도로 스캔
    // (src가 openaiish일 때, 여기에서 custom endpoint가 보통 걸림)
    const extraAreas = [];
    try {
      for (const [k, v] of Object.entries(settingsRoot)) {
        const kk = String(k).toLowerCase();
        if (kk.includes("chat") || kk.includes("completion") || kk.includes("source") || kk.includes("custom")) {
          if (v && typeof v === "object") extraAreas.push({ key: k, node: v });
        }
      }
    } catch (_) {}

    const extraUrls = [];
    for (const a of extraAreas) {
      const candidates = extractUrlCandidates(a.node);
      candidates.forEach(u => extraUrls.push({ url: u, where: `area:${a.key}` }));
    }
    const hit4141b = extraUrls.find(x => is4141(x.url));
    if (hit4141b) return { url: hit4141b.url.toLowerCase(), where: hit4141b.where };

    // 4) 마지막 fallback: openai_settings / oai_settings 쪽에서만 탐색
    const openaiAreas = [
      settingsRoot?.openai_settings,
      settingsRoot?.oai_settings,
      c?.openai_settings,
      c?.oai_settings,
      c?.settings?.openai_settings,
      c?.settings?.oai_settings,
    ].filter(Boolean);

    const fallbackUrls = [];
    for (const a of openaiAreas) {
      extractUrlCandidates(a).forEach(u => fallbackUrls.push({ url: u, where: "openai_settings" }));
    }
    const hit4141c = fallbackUrls.find(x => is4141(x.url));
    if (hit4141c) return { url: hit4141c.url.toLowerCase(), where: hit4141c.where };

    // 5) 없으면 빈값
    // (여기서 ctx 전체 뒤지면 다시 “Google로 바꿔도 4141 잔상” 문제가 재발해서 금지)
    return { url: "", where: "none" };
  }

  function analyzeCopilotNow() {
    const src = getActiveSource();
    addLog(`📌 활성 소스(src): ${src || "(없음)"}`);

    // Google/Gemini/OpenRouter는 즉시 차단
    if (src.includes("google") || src.includes("gemini") || src.includes("ai studio")) {
      addLog("❌ 소스가 Google/Gemini → Copilot 집계 금지");
      return { isCopilot: false, reason: `source=${src}`, source: src, endpoint: "" };
    }
    if (src.includes("openrouter")) {
      addLog("❌ 소스가 OpenRouter → Copilot 집계 금지");
      return { isCopilot: false, reason: `source=${src}`, source: src, endpoint: "" };
    }

    // endpoint는 “해당 src 설정 blob에서만” 추출
    const ep = getEndpointForActiveSource(src);
    addLog(`🔗 endpoint(추출): ${ep.url || "(없음)"}  [${ep.where}]`);

    // src가 openaiish(또는 못 읽는 환경)일 때만 endpoint로 Copilot 판정
    const isOpenAIish =
      src.includes("openai") ||
      src.includes("openai-compatible") ||
      src.includes("chat completion") ||
      src.includes("custom") ||
      src.includes("oai") ||
      src === "";

    if (!isOpenAIish) {
      addLog("❌ 소스가 OpenAI 계열이 아님 → Copilot 금지");
      return { isCopilot: false, reason: `not_openaiish_source=${src}`, source: src, endpoint: ep.url || "" };
    }

    if (is4141(ep.url)) {
      addLog("✅ Copilot 확정: (OpenAI 계열 + endpoint=4141)");
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
    lastGen = {
      isCopilot: r.isCopilot,
      startedAt: Date.now(),
      source: r.source || "",
      endpoint: r.endpoint || "",
      reason: r.reason || "",
    };
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
        #ccModal{background:#1e1e1e;border-radius:16px;width:100%;max-width:560px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);}
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
            <div class="ccSectionTitle">
              <span>📊 현재 Generation 상태</span>
              <span id="ccGenStatus" style="font-size:0.85em;opacity:0.8;">—</span>
            </div>
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
  // 메뉴(마법봉)
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

    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
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
