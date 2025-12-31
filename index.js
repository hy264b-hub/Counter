(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // ✅ Copilot(localhost:4141)일 때만 집계
function isCopilot4141() {
  const c = getCtx();

  const candidates = [
    c?.settings?.api_url,
    c?.settings?.apiUrl,
    c?.api_url,
    c?.apiUrl,
    c?.oai_settings?.api_url,
    c?.oai_settings?.apiUrl,
    c?.openai_settings?.api_url,
    c?.openai_settings?.apiUrl
  ];

  const base = (candidates.find(v => typeof v === "string") || "").toLowerCase();

  return (
    base.includes("localhost:4141") ||
    base.includes("127.0.0.1:4141") ||
    base.includes("0.0.0.0:4141")
  );
}


  // KST/로컬 기준 "오늘"
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
        // 중복 방지/판정용
        inFlight: null,         // { chatKey, startSig }
        lastCountedSig: {}      // { chatKey: sig }
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (!s.lastCountedSig) s.lastCountedSig = {};
    return s;
  }

  function save() {
    getCtx().saveSettingsDebounced();
  }

  function chatKey(ctx) {
    return `${ctx.groupId ?? "nogroup"}:${ctx.characterId ?? "nochar"}`;
  }

  // ✅ 메시지 텍스트 필드가 버전/모드마다 달라서, 가능한 후보를 다 본다.
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

  // ✅ “에러 메시지” 판단도 방어적으로
  function isErrorLike(msg) {
    if (!msg) return false;
    if (msg.is_error === true) return true;
    if (msg.error === true) return true;
    if (typeof msg.error === "string" && msg.error.trim().length > 0) return true;

    // 어떤 프록시는 { type: "error" } 같은 걸 넣기도 해서…
    if (msg.type === "error") return true;
    if (msg.status === "error") return true;
    return false;
  }

  function lastAssistant(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
      const m = chat[i];
      // staging에서 is_user 대신 role이 들어가는 케이스도 방어
      if (m?.is_user === false) return m;
      if (m?.role === "assistant") return m;
    }
    return null;
  }

  // ✅ send_date가 없거나 타입이 달라도 "시그니처"를 만들기
  // - 시간/아이디가 있으면 포함
  // - 없으면 텍스트 일부로 대체
  function signature(msg) {
    if (!msg) return "none";
    const t = getMsgText(msg).trim();
    const time =
      (typeof msg.send_date === "number" ? msg.send_date : null) ??
      (typeof msg.send_date === "string" ? msg.send_date : null) ??
      (typeof msg?.created === "number" ? msg.created : null) ??
      (typeof msg?.id === "string" ? msg.id : null) ??
      "";
    // 텍스트가 너무 길면 앞부분만
    const head = t.slice(0, 80);
    return `${String(time)}|${head}`;
  }

  function isValidAssistant(msg) {
    if (!msg) return false;
    if (isErrorLike(msg)) return false;
    const text = getMsgText(msg);
    if (typeof text !== "string") return false;
    if (text.trim().length === 0) return false; // 빈 응답 제외
    return true;
  }

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

  // --- Dashboard UI ---
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
      s.inFlight = null;
      s.lastCountedSig = {};
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
  }

  // --- 🪄 메뉴 주입 ---
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

  // --- ✅ 카운트 로직: GENERATION_STARTED / GENERATION_ENDED ---
  function onGenStarted() {
    const c = getCtx();
    const s = getSettings();
    const key = chatKey(c);
    const msg = lastAssistant(c.chat ?? []);
    s.inFlight = { chatKey: key, startSig: signature(msg) };
    save();
  }

  function increment() {
    const s = getSettings();
    const t = todayKeyLocal();
    s.total += 1;
    s.byDay[t] = (s.byDay[t] ?? 0) + 1;
    save();

    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  function onGenEnded(payload) {
    const c = getCtx();
    const s = getSettings();
    const key = chatKey(c);

    // 에러로 끝난 경우가 payload에 잡히면 제외(없어도 아래 검증이 막아줌)
    const endedWithError =
      payload?.is_error === true ||
      payload?.error === true ||
      (typeof payload?.error === "string" && payload.error.trim().length > 0);

    if (endedWithError) return;

    const msg = lastAssistant(c.chat ?? []);
    if (!isValidAssistant(msg)) return;

    const endSig = signature(msg);
    const startSig = s.inFlight?.chatKey === key ? s.inFlight.startSig : null;

    // 시작과 동일한 메시지면 “새 답변이 추가되지 않음”
    if (startSig && endSig === startSig) return;

    // 중복 방지 (같은 endSig를 또 세는 경우)
    if (s.lastCountedSig[key] === endSig) return;

    s.lastCountedSig[key] = endSig;
    s.inFlight = null;
    // ✅ Copilot(4141)일 때만 카운트
    if (!isCopilot4141()) return;
    
    increment();
  }

  function main() {
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    // ✅ 이 두 개가 프록시/localhost/streaming에서도 제일 안정적으로 잡힘
    if (event_types.GENERATION_STARTED) eventSource.on(event_types.GENERATION_STARTED, onGenStarted);
    if (event_types.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, onGenEnded);

    // 보험: 렌더 이벤트도 살아있으면 같이 사용해도 되는데,
    // 지금은 “중복 위험”을 줄이려고 generation 흐름만으로 충분히 구성했어.
  }

  main();
})();
