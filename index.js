(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // ✅ 한국(로컬) 날짜 기준: 오늘 키
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
      extensionSettings[MODULE] = { total: 0, byDay: {}, lastCounted: {} };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (!s.lastCounted) s.lastCounted = {};
    if (typeof s.total !== "number") s.total = 0;
    return s;
  }

  function save() {
    getCtx().saveSettingsDebounced();
  }

  // --- 카운트 대상 판정(빈응답/오류 제외) ---
  function lastAssistant(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
      if (chat[i]?.is_user === false) return chat[i];
    }
    return null;
  }

  function isValidAssistantMessage(msg) {
    if (!msg) return false;
    if (typeof msg.mes !== "string") return false;
    if (msg.mes.trim().length === 0) return false; // 빈 응답 제외

    // 오류 표시(백엔드/버전에 따라 다르니 방어적으로)
    if (msg.is_error === true) return false;
    if (msg.error === true) return false;
    if (typeof msg.error === "string" && msg.error.trim().length > 0) return false;

    // 중복 방지용 기준값
    if (typeof msg.send_date !== "number") return false;
    return true;
  }

  function chatKey(ctx) {
    return `${ctx.groupId ?? "nogroup"}:${ctx.characterId ?? "nochar"}`;
  }

  function increment() {
    const s = getSettings();
    const t = todayKeyLocal();
    s.total += 1;
    s.byDay[t] = (s.byDay[t] ?? 0) + 1;
    save();

    // 대시보드 열려있으면 즉시 갱신
    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  // --- 최근 N일 ---
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

  // --- 대시보드 UI ---
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
      s.lastCounted = {};
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

  // --- 🪄 마법봉(Extensions) 메뉴에 항목 주입 ---
  function findWandMenuContainer() {
    // staging에서 DOM이 바뀌어도 최대한 잡히도록 “가능한 후보를 여러 개”로 탐색
    const candidates = [
      "#extensions_menu",
      "#extensionsMenu",
      ".extensions_menu",
      ".extensions-menu",
      ".chatbar_extensions_menu",
      ".chatbar .dropdown-menu",
      ".chatbar .menu",
      ".chat_controls .dropdown-menu",
      ".chat-controls .dropdown-menu"
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el) return el;
    }

    // 마지막 보험: “Extensions” 텍스트를 가진 드롭다운을 찾기
    const dropdowns = Array.from(document.querySelectorAll(".dropdown-menu, .menu, ul"));
    const hit = dropdowns.find(d => d.textContent?.toLowerCase().includes("extensions"));
    return hit || null;
  }

  function injectWandMenuItem() {
    const menu = findWandMenuContainer();
    if (!menu) return false;

    if (menu.querySelector(`#${MENU_ITEM_ID}`)) return true;

    // 메뉴 아이템은 ST 테마마다 li/a/div 형태가 달라서, 최대한 무난한 버튼으로 삽입
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

  function observeForWandMenu() {
    // 메뉴가 열릴 때마다 DOM이 생성/갱신될 수 있어서, 변화 감지해서 주입
    const mo = new MutationObserver(() => {
      injectWandMenuItem();
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  // --- 이벤트로 “정상 답변” 카운트 ---
  function onAssistantRendered() {
    const c = getCtx();
    const s = getSettings();
    const msg = lastAssistant(c.chat ?? []);
    if (!isValidAssistantMessage(msg)) return;

    const key = chatKey(c);
    if (s.lastCounted[key] === msg.send_date) return; // 중복 방지

    s.lastCounted[key] = msg.send_date;
    increment();
  }

  function main() {
    ensureDashboard();

    // 이벤트 훅 + DOM 관찰
    const { eventSource, event_types } = getCtx();
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onAssistantRendered);

    // 마법봉 메뉴 항목 삽입(초기 1회 + 변경 감지)
    injectWandMenuItem();
    observeForWandMenu();
  }

  main();
})();
