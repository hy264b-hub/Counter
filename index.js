(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";
  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 로그/상태
  // =========================
  const logs = [];
  const MAX_LOGS = 80;

  function nowStr() {
    return new Date().toLocaleTimeString("ko-KR");
  }

  function addLog(msg) {
    logs.unshift(`[${nowStr()}] ${msg}`);
    if (logs.length > MAX_LOGS) logs.pop();
    const el = document.getElementById("ccLogs");
    if (el) el.innerHTML = logs.map(l => `<div>${escapeHtml(l)}</div>`).join("");
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, m => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    }[m]));
  }

  function safeJsonParse(text) {
    try { return JSON.parse(text); } catch { return null; }
  }

  // =========================
  // "실제 요청" 기반 라우트 태깅 (핵심)
  // - 설정/DOM은 신뢰하지 않는다(Blob/cached issue)
  // - ST 서버로 나가는 요청 body 안에 source / api_url / endpoint / provider 등이 들어있는 경우가 많음
  // =========================
  const ROUTE_WINDOW_MS = 2 * 60 * 1000; // 2분: 요청-응답 매칭 윈도우
  let lastRoute = {
    at: 0,
    kind: "unknown", // "copilot" | "google" | "other" | "unknown"
    why: "",
    model: "",
    url: "",
  };

  const NEEDLE_4141 = /localhost:4141|127\.0\.0\.1:4141|0\.0\.0\.0:4141|:4141\b|:4141\/v1/i;
  const NEEDLE_GOOGLE = /generativelanguage\.googleapis\.com|ai\.google\.dev|aistudio|ai studio|gemini|google/i;

  // "Google 직결"로 강하게 판단할 만한 키들(오탐 방지)
  const STRONG_GOOGLE = /generativelanguage\.googleapis\.com/i;

  function extractModel(obj) {
    if (!obj || typeof obj !== "object") return "";
    // 흔한 모델 필드들
    const candidates = [
      obj.model,
      obj?.data?.model,
      obj?.payload?.model,
      obj?.request?.model,
      obj?.parameters?.model,
      obj?.body?.model,
    ];
    const v = candidates.find(x => typeof x === "string" && x.trim());
    return v ? v.trim() : "";
  }

  function classifyRouteFromText(url, bodyText) {
    const u = (url || "").toString();
    const b = (bodyText || "").toString();
    const combined = `${u}\n${b}`;

    // 1) Google 직결(가장 확실): Google API 도메인
    if (STRONG_GOOGLE.test(combined)) {
      return { kind: "google", why: "strong_google_domain" };
    }

    // 2) 4141이 body/url 어딘가에 있으면 Copilot 라우팅
    if (NEEDLE_4141.test(combined)) {
      return { kind: "copilot", why: "needle_4141_in_url_or_body" };
    }

    // 3) google/gemini 단서가 있는데 4141은 없으면 google로 분류(약한 신호)
    if (NEEDLE_GOOGLE.test(combined) && !NEEDLE_4141.test(combined)) {
      return { kind: "google", why: "googleish_keywords_no_4141" };
    }

    // 4) 그 외
    return { kind: "other", why: "no_4141_no_google_domain" };
  }

  function tagRoute({ kind, why, model, url }) {
    lastRoute = {
      at: Date.now(),
      kind,
      why,
      model: model || "",
      url: url || "",
    };
    addLog(`🏷️ route=${kind} (${why})${model ? ` / model=${model}` : ""}`);
  }

  function isRecentCopilotRoute() {
    if (lastRoute.kind !== "copilot") return false;
    return (Date.now() - lastRoute.at) < ROUTE_WINDOW_MS;
  }

  // =========================
  // fetch 후킹 (Request 객체도 처리)
  // =========================
  (function hookFetch() {
    if (window.__ccFetchHooked_final) return;
    window.__ccFetchHooked_final = true;

    const origFetch = window.fetch.bind(window);

    window.fetch = async (...args) => {
      try {
        const input = args[0];
        const init = args[1] || {};

        // URL 추출
        let url = "";
        if (typeof input === "string") url = input;
        else if (input && typeof input.url === "string") url = input.url;

        // body 텍스트 추출
        let bodyText = "";
        // 1) init.body 우선
        if (init && init.body != null) {
          if (typeof init.body === "string") {
            bodyText = init.body;
          } else if (init.body && typeof init.body === "object" && !(init.body instanceof FormData)) {
            try { bodyText = JSON.stringify(init.body); } catch {}
          }
        }

        // 2) input이 Request면 clone해서 text 시도 (가능한 경우)
        if (!bodyText && input instanceof Request) {
          try {
            const cloned = input.clone();
            const t = await cloned.text();
            if (t && t.trim()) bodyText = t;
          } catch {}
        }

        // "채팅 생성"으로 보이는 요청만 태깅(너무 많은 요청 오염 방지)
        const looksGen =
          /generate|completion|chat|messages|api\/|backend|openai|gemini|anthropic/i.test(url) ||
          /"messages"\s*:|"prompt"\s*:|"model"\s*:/.test(bodyText);

        if (looksGen && (url || bodyText)) {
          const parsed = safeJsonParse(bodyText);
          const model = extractModel(parsed) || "";
          const { kind, why } = classifyRouteFromText(url, bodyText);
          tagRoute({ kind, why, model, url });
        }
      } catch (e) {
        // 후킹에서 죽으면 전체가 망함 → 절대 throw 금지
      }
      return origFetch(...args);
    };

    addLog("✅ fetch hook ON");
  })();

  // =========================
  // XHR 후킹 (ST가 XHR 쓰는 환경 대비)
  // =========================
  (function hookXHR() {
    if (window.__ccXHRHooked_final) return;
    window.__ccXHRHooked_final = true;

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      this.__ccUrl = url || "";
      return origOpen.call(this, method, url, ...rest);
    };

    XMLHttpRequest.prototype.send = function (body) {
      try {
        const url = this.__ccUrl || "";
        let bodyText = "";

        if (typeof body === "string") bodyText = body;
        else if (body && typeof body === "object" && !(body instanceof FormData)) {
          try { bodyText = JSON.stringify(body); } catch {}
        }

        const looksGen =
          /generate|completion|chat|messages|api\/|backend|openai|gemini|anthropic/i.test(url) ||
          /"messages"\s*:|"prompt"\s*:|"model"\s*:/.test(bodyText);

        if (looksGen && (url || bodyText)) {
          const parsed = safeJsonParse(bodyText);
          const model = extractModel(parsed) || "";
          const { kind, why } = classifyRouteFromText(url, bodyText);
          tagRoute({ kind, why, model, url });
        }
      } catch {}
      return origSend.call(this, body);
    };

    addLog("✅ XHR hook ON");
  })();

  // =========================
  // 저장/카운트
  // =========================
  function todayKeyLocal() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
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

  function getMsgText(msg) {
    if (!msg) return "";
    const candidates = [
      msg.mes, msg.message, msg.content, msg.text,
      msg?.data?.mes, msg?.data?.content, msg?.data?.message
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
    const time =
      (typeof msg?.send_date === "number" ? String(msg.send_date) : "") ||
      (typeof msg?.created === "number" ? String(msg.created) : "") ||
      (typeof msg?.id === "string" ? msg.id : "");
    return `${time}|${text.slice(0, 80)}`;
  }

  function lastAssistant(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      if (m?.is_user === false || m?.role === "assistant") return m;
    }
    return null;
  }

  function increment() {
    const s = getSettings();
    const t = todayKeyLocal();
    s.total += 1;
    s.byDay[t] = (s.byDay[t] ?? 0) + 1;
    save();
    addLog(`✅ COUNT +1 (today=${s.byDay[t]}, total=${s.total})`);
    if (document.getElementById(OVERLAY_ID)?.getAttribute("data-open") === "1") renderDashboard();
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
              <div class="ccSmall">Copilot(4141 route)만</div>
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
              <span>📡 마지막 라우트(실제 요청 기반)</span>
              <button class="ccBtn" id="ccClearLog" style="font-size:0.75em;padding:4px 8px;">로그 지우기</button>
            </div>
            <div id="ccStatus">
              <div><div style="opacity:0.7;margin-bottom:4px;">route</div><div id="ccRoute" style="font-weight:600;">-</div></div>
              <div><div style="opacity:0.7;margin-bottom:4px;">why</div><div id="ccWhy" style="font-weight:600;">-</div></div>
              <div><div style="opacity:0.7;margin-bottom:4px;">model</div><div id="ccModel" style="font-weight:600;">-</div></div>
              <div><div style="opacity:0.7;margin-bottom:4px;">url</div><div id="ccUrl" style="font-weight:600;">-</div></div>
              <div><div style="opacity:0.7;margin-bottom:4px;">age</div><div id="ccAge" style="font-weight:600;">-</div></div>
            </div>
          </div>

          <div class="ccSection">
            <div class="ccSectionTitle"><span>📋 실시간 로그</span></div>
            <div id="ccLogs">로그 대기 중...</div>
          </div>
        </div>

        <footer>
          <button class="ccBtn danger" id="ccResetBtn">전체 리셋</button>
          <button class="ccBtn primary" id="ccOpenBtn2">닫기</button>
        </footer>
      </div>
    `;

    overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDashboard(); });
    document.body.appendChild(overlay);

    document.getElementById("ccCloseBtn").addEventListener("click", closeDashboard);
    document.getElementById("ccOpenBtn2").addEventListener("click", closeDashboard);

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

    const ageMs = lastRoute.at ? (Date.now() - lastRoute.at) : 0;
    const ageS = lastRoute.at ? `${Math.floor(ageMs/1000)}s` : "-";
    document.getElementById("ccRoute").textContent = lastRoute.kind || "-";
    document.getElementById("ccWhy").textContent = lastRoute.why || "-";
    document.getElementById("ccModel").textContent = lastRoute.model || "-";
    document.getElementById("ccUrl").textContent = lastRoute.url ? lastRoute.url.slice(0, 200) : "-";
    document.getElementById("ccAge").textContent = ageS + (isRecentCopilotRoute() ? " (copilot-window)" : "");

    const el = document.getElementById("ccLogs");
    if (el) el.innerHTML = logs.map(l => `<div>${escapeHtml(l)}</div>`).join("");
  }

  // =========================
  // 메뉴 주입 (하단 마법봉/확장 메뉴에 반드시 뜨게)
  // =========================
  function findWandMenuContainer() {
    const selectors = [
      "#extensions_menu",
      "#extensionsMenu",
      ".extensions_menu",
      ".extensions-menu",
      ".chatbar_extensions_menu",
      ".chatbar .dropdown-menu",
      ".chat_controls .dropdown-menu",
      ".chat-controls .dropdown-menu",
      ".dropdown-menu",
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
  // 집계: "최근 route가 copilot"인 경우만 카운트
  // =========================
  function tryCountFromLastAssistant(eventName) {
    addLog(`📨 ${eventName}`);

    // ✅ 여기서 핵심: 설정이 아니라 "실제 요청 태그"로 판단
    if (!isRecentCopilotRoute()) {
      addLog(`❌ skip (route=${lastRoute.kind}, age=${lastRoute.at ? Math.floor((Date.now()-lastRoute.at)/1000) : "-"}s)`);
      return;
    }

    // Google 직결이면 무조건 제외(안전장치)
    if (lastRoute.kind === "google") {
      addLog("❌ skip (google direct)");
      return;
    }

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

  function onGenEnded() { tryCountFromLastAssistant("GENERATION_ENDED"); }
  function onCharacterRendered() { tryCountFromLastAssistant("CHARACTER_MESSAGE_RENDERED"); }
  function onMessageReceived() { tryCountFromLastAssistant("MESSAGE_RECEIVED"); }

  // =========================
  // main
  // =========================
  function main() {
    addLog("🚀 Copilot Counter boot");
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    // 생성 시작을 굳이 안써도 됨: 네트워크 요청에서 이미 태깅됨
    if (event_types?.GENERATION_ENDED) {
      eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
      addLog("✓ hook: GENERATION_ENDED");
    }
    if (event_types?.CHARACTER_MESSAGE_RENDERED) {
      eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
      addLog("✓ hook: CHARACTER_MESSAGE_RENDERED");
    }
    if (event_types?.MESSAGE_RECEIVED) {
      eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
      addLog("✓ hook: MESSAGE_RECEIVED");
    }

    addLog("✅ init done");
  }

  main();
})();
