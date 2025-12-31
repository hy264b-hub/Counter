(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // --- Copilot(4141) 판별: Custom Endpoint 입력값에서 확인 ---
  // 너가 말한 값: http://localhost:4141/v1
  function isCopilot4141Selected() {
    const needles = ["localhost:4141", "127.0.0.1:4141", "0.0.0.0:4141"];

    // input 요소들 중에 4141이 들어간 값이 있으면 Copilot로 간주
    const inputs = Array.from(document.querySelectorAll("input"));
    for (const el of inputs) {
      const v = (el?.value ?? "").toString().toLowerCase();
      if (!v) continue;
      if (needles.some(n => v.includes(n))) return true;
    }

    // 보험: 화면 텍스트에 4141이 박혀있는 경우 (일부 UI가 span으로 보여줄 수 있음)
    const bodyText = (document.body?.innerText ?? "").toLowerCase();
    if (needles.some(n => bodyText.includes(n))) return true;

    return false;
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
        lastSig: "" // 중복 방지
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

  // 메시지 텍스트 후보 넓게
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

  function isErrorLike(msg) {
    if (!msg) return false;
    if (msg.is_error === true) return true;
    if (msg.error === true) return true;
    if (typeof msg.error === "string" && msg.error.trim().length > 0) return true;
    if (msg.type === "error") return true;
    if (msg.status === "error") return true;
    return false;
  }

  // --- Dashboard UI ---
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
      s.lastSig = "";
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

  // --- ✅ 카운트 ---
  function increment() {
    const s = getSettings();
    const t = todayKeyLocal();
    s.total += 1;
    s.byDay[t] = (s.byDay[t] ?? 0) + 1;
    save();

    const overlay = document.getElementById(OVERLAY_ID);
    if (overlay?.getAttribute("data-open") === "1") renderDashboard();
  }

  // ✅ 가장 안정: MESSAGE_RECEIVED에서 assistant 메시지를 카운트
  function onMessageReceived(data) {
    // Copilot 선택 상태가 아닐 때는 집계 안 함
    if (!isCopilot4141Selected()) return;

    const msg = data?.message ?? data?.msg ?? data;

    const isAssistant =
      (msg?.is_user === false) ||
      (msg?.role === "assistant") ||
      (msg?.sender === "assistant");

    if (!isAssistant) return;
    if (isErrorLike(msg)) return;

    const text = getMsgText(msg);
    if (text.trim().length === 0) return;

    // 중복 방지 시그니처
    const sig =
      (typeof msg?.send_date === "number" ? String(msg.send_date) : "") ||
      (typeof msg?.id === "string" ? msg.id : "") ||
      (text.trim().slice(0, 80));

    const s = getSettings();
    if (s.lastSig === sig) return;
    s.lastSig = sig;

    increment();
  }

  function main() {
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    // ✅ 핵심: MESSAGE_RECEIVED
    if (event_types.MESSAGE_RECEIVED) {
      eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    } else {
      // staging에서 이름이 다를 수도 있어서, 가능한 후보를 몇 개 더 시도
      const fallbackNames = ["MESSAGE_RECEIVED", "message_received", "MESSAGE_RECEIVE"];
      for (const name of fallbackNames) {
        if (event_types[name]) {
          eventSource.on(event_types[name], onMessageReceived);
          break;
        }
      }
    }
  }

  main();
})();
