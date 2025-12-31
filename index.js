(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 로그 시스템
  // =========================
  const logs = [];
  const MAX_LOGS = 30;

  function addLog(msg) {
    const time = new Date().toLocaleTimeString('ko-KR');
    logs.unshift(`[${time}] ${msg}`);
    if (logs.length > MAX_LOGS) logs.pop();
    
    const logEl = document.getElementById("ccLogs");
    if (logEl) {
      logEl.innerHTML = logs.map(l => `<div>${l}</div>`).join('');
    }
  }

  // =========================
  // 1) "현재 선택된" 소스/엔드포인트로 Copilot 여부 판정
  // =========================
  function norm(s) {
    return (typeof s === "string" ? s : "").trim();
  }

  function getActiveChatCompletionSource() {
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
    if (v) {
      addLog(`📌 소스 발견(ctx): ${v}`);
      return v.toLowerCase();
    }

    // DOM select fallback
    try {
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const val = norm(sel?.value).toLowerCase();
        if (
          val.includes("openai") ||
          val.includes("google") ||
          val.includes("gemini") ||
          val.includes("openrouter") ||
          val.includes("claude") ||
          val.includes("anthropic")
        ) {
          addLog(`📌 소스 발견(DOM): ${val}`);
          return val;
        }
      }
    } catch (_) {}

    addLog("❌ 소스 없음");
    return "";
  }

  function getActiveCustomEndpoint() {
    const c = getCtx();

    const candidates = [
      c?.settings?.api_url,
      c?.settings?.apiUrl,
      c?.api_url,
      c?.apiUrl,
      c?.oai_settings?.api_url,
      c?.oai_settings?.apiUrl,
      c?.openai_settings?.api_url,
      c?.openai_settings?.apiUrl,
      c?.openai_settings?.base_url,
      c?.openai_settings?.baseUrl,
      c?.settings?.custom_endpoint,
      c?.settings?.customEndpoint,
    ];

    const v = candidates.map(norm).find(Boolean);
    if (v) {
      addLog(`🔗 엔드포인트(ctx): ${v}`);
      return v.toLowerCase();
    }

    // DOM input fallback
    try {
      const inputs = Array.from(document.querySelectorAll("input"));
      for (const el of inputs) {
        const vv = norm(el?.value).toLowerCase();
        if (!vv) continue;
        const looksLikeUrl = vv.startsWith("http://") || vv.startsWith("https://");
        if (!looksLikeUrl) continue;
        if (vv.includes("/v1") || vv.includes("localhost") || vv.includes("127.0.0.1")) {
          addLog(`🔗 엔드포인트(DOM): ${vv}`);
          return vv;
        }
      }
    } catch (_) {}

    addLog("❌ 엔드포인트 없음");
    return "";
  }

  function isCopilotSelectedNow() {
    addLog("🔍 Copilot 체크 시작...");
    
    const src = getActiveChatCompletionSource();
    const endpoint = getActiveCustomEndpoint();

    const endpointIs4141 =
      endpoint.includes("localhost:4141") ||
      endpoint.includes("127.0.0.1:4141") ||
      endpoint.includes("0.0.0.0:4141") ||
      endpoint.includes(":4141/") ||
      endpoint.endsWith(":4141");

    // Google/Gemini 제외
    const isGoogleish = src.includes("google") || src.includes("gemini") || src.includes("ai studio");
    if (isGoogleish) {
      addLog(`❌ Google 감지: ${src}`);
      return { ok: false, reason: "source=google", src, endpoint };
    }

    // OpenRouter 제외
    const isOpenRouter = src.includes("openrouter");
    if (isOpenRouter) {
      addLog(`❌ OpenRouter 감지: ${src}`);
      return { ok: false, reason: "source=openrouter", src, endpoint };
    }

    // Copilot = OpenAI-compatible + 4141
    const isOpenAIish =
      src.includes("openai") ||
      src.includes("oai") ||
      src.includes("openai-compatible") ||
      src.includes("openai compatible") ||
      src.includes("chat completion") ||
      src.includes("custom");

    if (endpointIs4141 && (isOpenAIish || !src)) {
      addLog(`✅ Copilot 확정! (${src || "기본"} + 4141)`);
      return { ok: true, reason: "endpoint=4141", src, endpoint };
    }

    addLog(`❌ Copilot 아님 (src=${src}, ep=${endpoint.slice(0,40)})`);
    return { ok: false, reason: "not-4141-or-not-openaiish", src, endpoint };
  }

  // =========================
  // 2) generation 태그
  // =========================
  let lastGen = { isCopilot: false, startedAt: 0, src: "", endpoint: "", reason: "" };
  const GEN_WINDOW_MS = 5 * 60 * 1000; // 5분

  function tagGenerationStart() {
    const det = isCopilotSelectedNow();
    lastGen = {
      isCopilot: det.ok,
      startedAt: Date.now(),
      src: det.src || "",
      endpoint: det.endpoint || "",
      reason: det.reason || ""
    };
    
    if (det.ok) {
      addLog(`🏷️ Generation 태깅: COPILOT`);
    } else {
      addLog(`🏷️ Generation 태깅: ${det.reason}`);
    }
  }

  function isThisGenCopilot() {
    if (!lastGen.isCopilot) return false;
    return (Date.now() - lastGen.startedAt) < GEN_WINDOW_MS;
  }

  // =========================
  // 3) 저장/설정
  // =========================
  function todayKeyLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function getSettings() {
    const { extensionSettings } = getCtx();
    if (!extensionSettings[MODULE]) {
      extensionSettings[MODULE] = {
        total: 0,
        byDay: {},
        lastSig: ""
      };
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
  // 4) 메시지 파싱
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
  // 5) UI
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
        #${OVERLAY_ID}{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:10000;align-items:center;justify-content:center;padding:10px;}
        #${OVERLAY_ID}[data-open="1"]{display:flex;}
        #ccModal{background:#1e1e1e;border-radius:16px;width:100%;max-width:500px;max-height:90vh;overflow-y:auto;box-shadow:0 8px 32px rgba(0,0,0,0.6);}
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
        .ccSectionTitle{font-size:0.9em;font-weight:600;margin-bottom:8px;}
        #ccStatus{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:0.75em;margin-bottom:8px;}
        #ccStatus div{padding:8px;background:rgba(255,255,255,0.05);border-radius:6px;}
        #ccLogs{background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.1);border-radius:8px;padding:10px;max-height:250px;overflow-y:auto;font-family:monospace;font-size:0.7em;line-height:1.5;}
        #ccLogs div{padding:2px 0;border-bottom:1px solid rgba(255,255,255,0.05);}
        #ccModal footer{padding:12px 16px;border-top:1px solid rgba(255,255,255,0.1);display:flex;gap:8px;justify-content:flex-end;position:sticky;bottom:0;background:#1e1e1e;}
        .ccBtn{padding:8px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.1);color:white;cursor:pointer;font-size:0.85em;}
        .ccBtn:active{background:rgba(255,255,255,0.2);}
        .ccBtn.danger{background:rgba(220,38,38,0.2);border-color:rgba(220,38,38,0.4);}
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

          <div class="ccSection">
            <div class="ccSectionTitle">📊 현재 상태</div>
            <div id="ccStatus">
              <div>
                <div style="opacity:0.6;">태그</div>
                <div id="ccTag" style="font-weight:600;margin-top:4px;">-</div>
              </div>
              <div>
                <div style="opacity:0.6;">경과</div>
                <div id="ccElapsed" style="font-weight:600;margin-top:4px;">-</div>
              </div>
              <div style="grid-column:1/-1;">
                <div style="opacity:0.6;">소스</div>
                <div id="ccSrc" style="font-weight:600;margin-top:4px;word-break:break-all;">-</div>
              </div>
              <div style="grid-column:1/-1;">
                <div style="opacity:0.6;">엔드포인트</div>
                <div id="ccEndpoint" style="font-weight:600;margin-top:4px;word-break:break-all;">-</div>
              </div>
            </div>
          </div>

          <div class="ccSection">
            <div class="ccSectionTitle">📋 실시간 로그</div>
            <div id="ccLogs">로그 대기 중...</div>
          </div>
        </div>

        <footer>
          <button class="ccBtn danger" id="ccResetBtn" type="button">리셋</button>
          <button class="ccBtn" id="ccTestBtn" type="button">테스트</button>
          <button class="ccBtn" id="ccCloseBtn2" type="button">닫기</button>
        </footer>
      </div>
    `;

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDashboard(); });

    document.body.appendChild(overlay);
    document.getElementById("ccCloseBtn").addEventListener("click", closeDashboard);
    document.getElementById("ccCloseBtn2").addEventListener("click", closeDashboard);
    
    document.getElementById("ccTestBtn").addEventListener("click", () => {
      addLog("🧪 수동 테스트 시작");
      tagGenerationStart();
      renderDashboard();
    });

    document.getElementById("ccResetBtn").addEventListener("click", () => {
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

    // 상태 업데이트
    const elapsed = lastGen.startedAt ? (Date.now() - lastGen.startedAt) : 0;
    document.getElementById("ccTag").textContent = lastGen.isCopilot ? "✅ Copilot" : "❌ 아님";
    document.getElementById("ccElapsed").textContent = elapsed > 0 ? `${Math.floor(elapsed/1000)}초 전` : "-";
    document.getElementById("ccSrc").textContent = lastGen.src || "-";
    document.getElementById("ccEndpoint").textContent = lastGen.endpoint || "-";

    // 로그 업데이트
    const logEl = document.getElementById("ccLogs");
    if (logEl && logs.length > 0) {
      logEl.innerHTML = logs.map(l => `<div>${l}</div>`).join('');
    }
  }

  // =========================
  // 6) 메뉴
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
      padding: 10px 12px;
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
  // 7) 집계
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
    addLog(`📨 이벤트: ${eventName}`);
    
    const c = getCtx();
    const chat = c.chat ?? [];
    const msg = lastAssistant(chat);
    
    if (!msg) {
      addLog("❌ 어시스턴트 메시지 없음");
      return;
    }

    if (!isThisGenCopilot()) {
      addLog(`❌ Copilot generation 아님 (${lastGen.reason})`);
      return;
    }

    const isAssistant =
      (msg?.is_user === false) ||
      (msg?.role === "assistant") ||
      (msg?.sender === "assistant");
    if (!isAssistant) {
      addLog("❌ 사용자 메시지");
      return;
    }
    
    if (isErrorLike(msg)) {
      addLog("❌ 에러 메시지");
      return;
    }

    const text = getMsgText(msg);
    if (text.trim().length === 0) {
      addLog("❌ 빈 메시지");
      return;
    }

    const s = getSettings();
    const sig = signatureFromMessage(msg);
    if (!sig || sig === "none|") {
      addLog("❌ 잘못된 시그니처");
      return;
    }
    
    if (s.lastSig === sig) {
      addLog("❌ 중복 메시지");
      return;
    }

    s.lastSig = sig;
    increment();
  }

  function onGenStarted(_payload) {
    addLog("🚀 Generation 시작");
    tagGenerationStart();
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  function onGenEnded(_payload) {
    tryCountFromLastAssistant("GEN_END");
  }

  function onCharacterRendered() {
    tryCountFromLastAssistant("CHAR_RENDER");
  }

  function onMessageReceived() {
    tryCountFromLastAssistant("MSG_RECV");
  }

  function main() {
    addLog("🚀 Copilot Counter 시작");
    
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    if (event_types?.GENERATION_STARTED) {
      eventSource.on(event_types.GENERATION_STARTED, onGenStarted);
      addLog("✓ GENERATION_STARTED 등록");
    }
    if (event_types?.GENERATION_ENDED) {
      eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
      addLog("✓ GENERATION_ENDED 등록");
    }
    if (event_types?.CHARACTER_MESSAGE_RENDERED) {
      eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
      addLog("✓ CHARACTER_MESSAGE_RENDERED 등록");
    }
    if (event_types?.MESSAGE_RECEIVED) {
      eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
      addLog("✓ MESSAGE_RECEIVED 등록");
    }

    addLog("✅ 초기화 완료!");
  }

  main();
})();
