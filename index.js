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
  // 광범위한 설정 스캔
  // =========================
  function deepScan(obj, path = "", maxDepth = 4) {
    const results = [];
    if (!obj || typeof obj !== "object" || maxDepth <= 0) return results;

    for (const key in obj) {
      try {
        const val = obj[key];
        const newPath = path ? `${path}.${key}` : key;
        
        if (typeof val === "string" && val.trim()) {
          const lower = val.toLowerCase();
          // URL이나 API 소스처럼 보이는 값만
          if (
            lower.includes("localhost") ||
            lower.includes("127.0.0.1") ||
            lower.includes(":4141") ||
            lower.includes("openai") ||
            lower.includes("google") ||
            lower.includes("gemini") ||
            lower.includes("http://") ||
            lower.includes("https://") ||
            lower.includes("/v1")
          ) {
            results.push({ path: newPath, value: val });
          }
        }
        
        if (typeof val === "object" && val !== null) {
          results.push(...deepScan(val, newPath, maxDepth - 1));
        }
      } catch (_) {}
    }
    
    return results;
  }

  function scanAllSettings() {
    addLog("🔍 전체 설정 스캔 시작...");
    
    const c = getCtx();
    const allFindings = [];

    // 1. Context 객체 스캔
    const ctxResults = deepScan(c, "ctx");
    allFindings.push(...ctxResults);
    
    // 2. window 객체에서 SillyTavern 관련 찾기
    try {
      if (window.SillyTavern) {
        const stResults = deepScan(window.SillyTavern, "ST");
        allFindings.push(...stResults);
      }
    } catch (_) {}

    // 3. DOM에서 찾기
    try {
      // Select 태그들
      document.querySelectorAll("select").forEach((sel, idx) => {
        const val = sel.value?.trim();
        if (val) {
          allFindings.push({ path: `DOM.select[${idx}]`, value: val });
        }
      });
      
      // Input 태그들 (URL 형태만)
      document.querySelectorAll("input[type='text'], input[type='url']").forEach((inp, idx) => {
        const val = inp.value?.trim();
        if (val && (val.startsWith("http") || val.includes("localhost") || val.includes("127.0.0.1"))) {
          allFindings.push({ path: `DOM.input[${idx}]`, value: val });
        }
      });
    } catch (_) {}

    // 결과 로깅
    if (allFindings.length === 0) {
      addLog("❌ 아무 설정도 찾지 못함");
    } else {
      addLog(`📋 총 ${allFindings.length}개 설정 발견:`);
      allFindings.forEach(f => {
        const short = f.value.length > 60 ? f.value.slice(0, 60) + "..." : f.value;
        addLog(`  • ${f.path}: ${short}`);
      });
    }

    return allFindings;
  }

  function analyzeCopilot(findings) {
    addLog("🔍 Copilot 분석 시작...");
    
    let copilotEndpoint = null;
    let apiSource = null;

    // 4141 포트 찾기
    for (const f of findings) {
      const val = f.value.toLowerCase();
      if (val.includes(":4141") || val.includes("localhost:4141") || val.includes("127.0.0.1:4141")) {
        copilotEndpoint = f;
        addLog(`✅ 4141 엔드포인트 발견: ${f.path}`);
        break;
      }
    }

    // API 소스 찾기
    for (const f of findings) {
      const val = f.value.toLowerCase();
      const isSource = 
        val.includes("openai") || 
        val.includes("google") || 
        val.includes("gemini") ||
        val.includes("claude") ||
        val.includes("anthropic");
      
      if (isSource && !val.includes("http")) {
        apiSource = f;
        addLog(`📌 API 소스 발견: ${f.path} = ${f.value}`);
        break;
      }
    }

    // ✅ 판정: 엔드포인트가 4141이면 무조건 Copilot (소스 이름 무시)
    if (copilotEndpoint) {
      const sourceVal = apiSource?.value || "";
      addLog(`✅ Copilot 확정! (엔드포인트 4141 감지)`);
      addLog(`  └ 소스: ${sourceVal || "없음"} (Copilot을 통해 접속)`);
      return { 
        isCopilot: true, 
        reason: "copilot-via-4141", 
        endpoint: copilotEndpoint.value, 
        source: sourceVal 
      };
    }

    addLog("❌ 4141 엔드포인트 없음 - Copilot 아님");
    return { isCopilot: false, reason: "no-4141", endpoint: "", source: apiSource?.value || "" };
  }

  // =========================
  // Generation 태그
  // =========================
  let lastGen = { isCopilot: false, startedAt: 0, source: "", endpoint: "", reason: "" };
  const GEN_WINDOW_MS = 5 * 60 * 1000;

  function tagGenerationStart() {
    const findings = scanAllSettings();
    const result = analyzeCopilot(findings);
    
    lastGen = {
      isCopilot: result.isCopilot,
      startedAt: Date.now(),
      source: result.source || "",
      endpoint: result.endpoint || "",
      reason: result.reason || ""
    };
    
    if (result.isCopilot) {
      addLog(`🏷️ Generation: COPILOT`);
    } else {
      addLog(`🏷️ Generation: ${result.reason}`);
    }
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
      extensionSettings[MODULE] = {
        total: 0,
        byDay: {},
        lastSig: ""
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
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
    const candidates = [msg.mes, msg.message, msg.content, msg.text];
    return candidates.find(v => typeof v === "string") ?? "";
  }

  function isErrorLike(msg) {
    if (!msg) return false;
    return msg.is_error === true || msg.error === true;
  }

  function signatureFromMessage(msg) {
    const text = getMsgText(msg).trim();
    const time = String(msg?.send_date || msg?.created || msg?.id || "");
    return `${time}|${text.slice(0, 80)}`;
  }

  function lastAssistant(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i]?.is_user === false) return chat[i];
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
    document.getElementById("ccCloseBtn").addEventListener("click", closeDashboard);
    document.getElementById("ccCloseBtn2").addEventListener("click", closeDashboard);
    
    document.getElementById("ccClearLog").addEventListener("click", () => {
      logs.length = 0;
      addLog("🗑️ 로그 지움");
    });
    
    document.getElementById("ccScanBtn").addEventListener("click", () => {
      addLog("🔄 수동 스캔 시작");
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
      list.innerHTML += `
        <div class="ccBarRow">
          <div class="ccBarDate">${k.slice(5)}</div>
          <div class="ccBarTrack"><div class="ccBarFill" style="width:${pct}%"></div></div>
          <div class="ccBarNum">${v}</div>
        </div>
      `;
    });

    document.getElementById("ccBarsHint").textContent = `max ${max}`;

    // 상태
    const elapsed = lastGen.startedAt ? Math.floor((Date.now() - lastGen.startedAt) / 1000) : 0;
    document.getElementById("ccGenStatus").textContent = 
      lastGen.isCopilot ? `✅ Copilot (${elapsed}초 전)` : `❌ 아님 (${elapsed}초 전)`;
    document.getElementById("ccSrc").textContent = lastGen.source || "-";
    document.getElementById("ccEndpoint").textContent = lastGen.endpoint || "-";
    document.getElementById("ccReason").textContent = lastGen.reason || "-";

    // 로그
    const logEl = document.getElementById("ccLogs");
    if (logEl && logs.length > 0) {
      logEl.innerHTML = logs.map(l => `<div>${l}</div>`).join('');
    }
  }

  // =========================
  // 메뉴
  // =========================
  function findWandMenuContainer() {
    return document.querySelector("#extensions_menu") || 
           document.querySelector("#extensionsMenu") ||
           document.querySelector(".extensions_menu");
  }

  function injectWandMenuItem() {
    const menu = findWandMenuContainer();
    if (!menu || menu.querySelector(`#${MENU_ITEM_ID}`)) return;

    const item = document.createElement("div");
    item.id = MENU_ITEM_ID;
    item.style.cssText = `padding:10px 12px;cursor:pointer;user-select:none;border-radius:10px;margin:4px 6px;border:1px solid rgba(255,255,255,.10);background:rgba(255,255,255,.04);`;
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
      addLog(`❌ Copilot gen 아님`);
      return;
    }

    const c = getCtx();
    const msg = lastAssistant(c.chat ?? []);
    if (!msg) {
      addLog("❌ 어시스턴트 메시지 없음");
      return;
    }
    
    if (isErrorLike(msg)) {
      addLog("❌ 에러");
      return;
    }

    const text = getMsgText(msg);
    if (!text.trim()) {
      addLog("❌ 빈 메시지");
      return;
    }

    const s = getSettings();
    const sig = signatureFromMessage(msg);
    if (s.lastSig === sig) {
      addLog("❌ 중복");
      return;
    }

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

    if (event_types?.GENERATION_STARTED) {
      eventSource.on(event_types.GENERATION_STARTED, onGenStarted);
      addLog("✓ GENERATION_STARTED");
    }
    if (event_types?.GENERATION_ENDED) {
      eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
      addLog("✓ GENERATION_ENDED");
    }
    if (event_types?.CHARACTER_MESSAGE_RENDERED) {
      eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
      addLog("✓ CHARACTER_MESSAGE_RENDERED");
    }
    if (event_types?.MESSAGE_RECEIVED) {
      eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
      addLog("✓ MESSAGE_RECEIVED");
    }

    addLog("✅ 초기화 완료");
  }

  main();
})();
