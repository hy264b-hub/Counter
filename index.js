(() => {
  const MODULE = "copilot_counter";
  const MENU_ITEM_ID = "ccWandMenuItem";
  const OVERLAY_ID = "ccModalOverlay";

  const getCtx = () => SillyTavern.getContext();

  // =========================
  // 1) Copilot(4141) 판별 (절대 안 죽는 버전)
  // - DOM input이 없어도 OK
  // - getContext 어디에 숨어 있어도 OK (얕은 탐색)
  // - localStorage에 저장돼 있어도 OK
  // =========================
  const COPILOT_NEEDLES = ["localhost:4141", "127.0.0.1:4141", "0.0.0.0:4141", ":4141/v1", ":4141"];

  function includes4141(s) {
    if (typeof s !== "string") return false;
    const v = s.toLowerCase();
    return COPILOT_NEEDLES.some(n => v.includes(n));
  }

  function searchObjectForNeedle(obj, maxDepth = 4) {
    // { found: boolean, path: string, value: string }
    const seen = new Set();

    function walk(node, path, depth) {
      if (depth > maxDepth) return null;
      if (!node || typeof node !== "object") return null;
      if (seen.has(node)) return null;
      seen.add(node);

      // 문자열 직접 체크
      if (typeof node === "string") {
        if (includes4141(node)) return { found: true, path, value: node };
        return null;
      }

      // 배열/객체 순회
      const entries = Array.isArray(node)
        ? node.map((v, i) => [String(i), v])
        : Object.entries(node);

      for (const [k, v] of entries) {
        if (typeof v === "string" && includes4141(v)) {
          return { found: true, path: path ? `${path}.${k}` : k, value: v };
        }
        if (v && typeof v === "object") {
          const res = walk(v, path ? `${path}.${k}` : k, depth + 1);
          if (res) return res;
        }
      }
      return null;
    }

    return walk(obj, "", 0);
  }

  function searchLocalStorageForNeedle() {
    try {
      // 너무 많이 돌면 느려질 수 있어서 제한
      const keys = Object.keys(localStorage || {}).slice(0, 50);
      for (const k of keys) {
        const raw = localStorage.getItem(k);
        if (!raw) continue;
        if (includes4141(raw)) return { found: true, key: k, value: raw.slice(0, 200) };

        // JSON이면 파싱해서 더 정확히
        if (raw.startsWith("{") || raw.startsWith("[")) {
          try {
            const obj = JSON.parse(raw);
            const res = searchObjectForNeedle(obj, 4);
            if (res?.found) return { found: true, key: k, path: res.path, value: res.value };
          } catch (_) {}
        }
      }
    } catch (_) {}
    return null;
  }

  function detectCopilot4141() {
  // ✅ "현재 선택된 Custom Endpoint"만 보고 판정한다.
  // - context/localStorage는 과거 기록이 남아서 오탐 발생 → 사용하지 않음
  // - Copilot일 때 Custom Endpoint에 http://localhost:4141/v1 이 들어간다고 했으니
  //   '현재 input value'에서만 4141을 찾는다.

  const needles = ["localhost:4141", "127.0.0.1:4141", "0.0.0.0:4141"];

  // input 후보 중 "URL처럼 보이는 값"만 대상으로 한다(키/프롬프트 input 오탐 방지)
  const inputs = Array.from(document.querySelectorAll("input"));
  for (const el of inputs) {
    const v = (el?.value ?? "").toString().toLowerCase().trim();
    if (!v) continue;

    const looksLikeEndpoint =
      v.startsWith("http://") ||
      v.startsWith("https://") ||
      v.includes("/v1");

    if (!looksLikeEndpoint) continue;

    if (needles.some(n => v.includes(n))) {
      return { ok: true, where: "dom:current-endpoint", value: v };
    }
  }

  // (보험) 설정 UI가 접혀서 input이 DOM에 없을 때:
  // 화면 텍스트에 endpoint 문자열이 "현재값"으로 표시되는 경우만 제한적으로 탐지
  const txt = (document.body?.innerText ?? "").toLowerCase();
  const hasNeedle = needles.some(n => txt.includes(n));
  const mentionsEndpoint = txt.includes("custom endpoint") || txt.includes("endpoint");
  if (hasNeedle && mentionsEndpoint) {
    return { ok: true, where: "dom:text-endpoint", value: "bodyText" };
  }

  return { ok: false, where: "dom:not-selected", value: "" };
}


  // =========================
  // 2) 날짜/저장
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
        debug: {
          lastEvent: "",
          lastCopilotDetect: "",
        }
      };
    }
    const s = extensionSettings[MODULE];
    if (!s.byDay) s.byDay = {};
    if (typeof s.total !== "number") s.total = 0;
    if (typeof s.lastSig !== "string") s.lastSig = "";
    if (!s.debug) s.debug = { lastEvent: "", lastCopilotDetect: "" };
    return s;
  }

  function save() {
    getCtx().saveSettingsDebounced();
  }

  // =========================
  // 3) 메시지 파싱/유효성
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

  function signatureFromMessage(msg) {
    const text = getMsgText(msg).trim();
    const time =
      (typeof msg?.send_date === "number" ? String(msg.send_date) : "") ||
      (typeof msg?.created === "number" ? String(msg.created) : "") ||
      (typeof msg?.id === "string" ? msg.id : "");
    const head = text.slice(0, 80);
    return `${time}|${head}`;
  }

  // =========================
  // 4) UI (대시보드)
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

          <!-- 디버그: 폰이라 콘솔 못 볼 때 여기서 확인 -->
          <div class="ccCard" style="padding:10px;border-radius:14px;border:1px solid rgba(255,255,255,.12);background:rgba(255,255,255,.04)">
            <div class="ccLabel">상태</div>
            <div class="ccSmall" id="ccDebugLine">—</div>
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
      s.debug = { lastEvent: "", lastCopilotDetect: "" };
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
      dbg.textContent = `event=${s.debug?.lastEvent || "-"} / copilot=${s.debug?.lastCopilotDetect || "-"}`;
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

  // =========================
  // 6) 집계: 여러 이벤트를 동시에 구독해서 "절대 안 죽게"
  // - 어떤 환경은 MESSAGE_RECEIVED만 뜨고
  // - 어떤 환경은 GENERATION_ENDED만 뜨고
  // - 어떤 환경은 CHARACTER_MESSAGE_RENDERED만 뜸
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
    s.debug.lastEvent = eventName || "";
    const det = detectCopilot4141();
    s.debug.lastCopilotDetect = det.ok ? `YES (${det.where})` : `NO (${det.where})`;
    save();

    // Copilot(4141) 아닐 때는 카운트 안 함
    if (!det.ok) return;

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
  }

  function onMessageReceived(data) {
    const msg = data?.message ?? data?.msg ?? data;
    tryCountFromMessage(msg, "MESSAGE_RECEIVED");
  }

  function onCharacterRendered() {
    // context.chat에서 마지막 assistant를 뽑는 방식 (payload가 없을 때)
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
    // generation 종료 시점에 마지막 assistant를 채팅에서 뽑아 카운트
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

  function main() {
    ensureDashboard();
    injectWandMenuItem();
    observeForMenu();

    const { eventSource, event_types } = getCtx();

    // 다 잡아둠 (안 뜨는 건 무시됨)
    if (event_types?.MESSAGE_RECEIVED) eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    if (event_types?.CHARACTER_MESSAGE_RENDERED) eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onCharacterRendered);
    if (event_types?.GENERATION_ENDED) eventSource.on(event_types.GENERATION_ENDED, onGenEnded);
  }

  main();
})();
