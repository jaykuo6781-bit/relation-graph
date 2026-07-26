/* 应用逻辑。原生 JS,无框架、无构建。
 *
 * 三个标签页:图谱 / 人物 / 设置。
 * 四个分析功能(敌人的敌人、派系、关键人物、不稳定三角)不单独占页面,
 * 而是折叠在点开某个人时弹出的卡片里 —— 你在看谁,就分析谁。
 */

const S = {
  state: null,
  people: [],
  circle: null,          // 当前圈子对象
  view: "graph",
  graph: null,
  byFaction: false,
  graphLoaded: false,
  files: [],             // AI 输入栏里待发送的附件
  pair: null,            // 连线卡当前展示的那一对(删除/改强度要拿原始行)
  patched: false,        // 图上有过增量补丁 → 复位键变成"重新排布"
};

const STRENGTH_LABEL = {
  3: "极亲近", 2: "关系不错", 1: "略有交情", 0: "中性",
  "-1": "略有嫌隙", "-2": "有明显矛盾", "-3": "势不两立",
};

/* ---------------- 基础工具 ---------------- */

async function api(path, body) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({ error: "服务器返回的不是 JSON" }));
  if (j && j.error) throw new Error(j.error);
  return j;
}

const cq = (extra) => {
  const cid = S.circle ? S.circle.id : "";
  return `circle=${cid}${extra || ""}`;
};

/* 视口宽高比 —— 服务端据此决定画布是宽的还是竖的。
   写死正方形画布的后果:宽屏上左右各空一半,竖屏上反过来。 */
function viewAspect() {
  const r = $("#stage").getBoundingClientRect();
  return r.height > 0 ? (r.width / r.height).toFixed(2) : "1";
}

/* AI 输入栏的实测高度写成 CSS 变量 --aibar-h。
   它会随内容变高(textarea 换行到 108px、挂了附件还要再加一行缩略图),
   所以图例的落点和 bottomInset() 都必须读同一个真值 —— 各自估一个数,
   迟早对不上。之前图例写死 bottom:14px、输入栏 bottom:12px,
   两者完全重叠且输入栏 z-index 更高,图例从来没被人看见过。 */
function measureAiBar() {
  const bar = $("#aibar"), stage = $("#stage");
  if (!bar || !stage) return;
  const h = bar.classList.contains("hidden")
    ? 0 : bar.getBoundingClientRect().height;
  stage.style.setProperty("--aibar-h", h.toFixed(0) + "px");
}

function watchAiBar() {
  const bar = $("#aibar");
  if (!bar) return;
  // ResizeObserver 只在高度真的变化时回调,不是每帧
  if (typeof ResizeObserver === "function") new ResizeObserver(measureAiBar).observe(bar);
  measureAiBar();
}

/* 图要避开的下方遮挡:AI 输入栏 + 安全区。
   v2 这里写死了 90,结果下缘的节点被输入框吃掉。 */
function bottomInset() {
  const stage = $("#stage");
  if (!stage) return 0;
  const v = parseFloat(getComputedStyle(stage).getPropertyValue("--aibar-h"));
  return v > 0 ? v + 24 : 0;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

function $(sel) { return document.querySelector(sel); }

/* 搜索键:姓名 + 部门 + 职位 + 标签,全部小写。
   人物页把它预存进每一行的 data-q,选人面板每次现算 —— 但**必须是同一个
   函数**。两处各写一份的话,同一个关键词在两个地方会搜出不同结果,
   而用户只会以为是数据坏了。fittest.js 里钉了"只有这一份"。 */
function searchKey(p) {
  return (p.name + p.dept + p.title + p.tags).toLowerCase();
}

let toastTimer;
let undoAction = null;          // 「撤销」toast 上挂着的那个动作

/* 非模态 show():同样进 top layer(所以能盖住 showModal 的卡片),
   但不抢焦点、不加遮罩、不拦背后的点击。重复 show() 会抛,先判 open。 */
/* 卡片开着时把 toast 搬进那个 dialog 里再显示。
   模态 dialog 在 top layer,外面的一切被设为 inert —— 留在 body 里的 toast
   既被盖住也点不动,而「撤销」是必须能点的。
   (非模态的 dialog.show() 不进 top layer,那条路走不通。) */
function showToast(t) {
  const dlg = document.getElementById("sheet");
  const host = (dlg && dlg.open) ? dlg : document.body;
  if (t.parentNode !== host) host.appendChild(t);
  t.classList.remove("hidden");
}

function toast(msg) {
  const t = $("#toast");
  undoAction = null;            // 新提示盖掉旧提示,旧的撤销机会一并作废
  t.textContent = msg;
  t.style.cursor = "";
  showToast(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 2600);
}

/* 删除不再弹 confirm,改成「已删除 · 撤销」。
   个人应用里 undo 比二次确认既好用又更安全 —— 二次确认只是把"确定吗"
   往前挪一步,点错了照样没了;撤销是真的能拿回来。
   整条 toast 都是热区(手机上不必去戳那两个字),窗口给到 5.2 秒。 */
function toastUndo(msg, undo) {
  const t = $("#toast");
  undoAction = undo;
  t.innerHTML = `${esc(msg)} · <b>撤销</b>`;
  t.style.cursor = "pointer";
  showToast(t);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, 5200);
}

function hideToast() {
  undoAction = null;
  $("#toast").classList.add("hidden");
}

/* 把一个 async 事件处理器包起来,失败时给出人话提示。
   在这之前,导入/改名/删除这些按钮全都是裸 `await api(...)` —— 服务端返回
   {"error": ...} 时 api() 会 throw,而没人 catch,于是变成一条未处理的
   Promise rejection:按钮按下去,没 toast、没变化、什么都不发生,
   用户只会再按一次。 */
function guard(fn, label) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (e) {
      busy(false);
      toast(humanError(e, label));
    }
  };
}

/* fetch 本身失败(服务没开、手机不在 Tailscale 里)时抛的是
   "Failed to fetch" —— 一句用户完全看不懂的英文。 */
function humanError(e, label) {
  const m = (e && e.message) || String(e);
  if (/failed to fetch|networkerror|load failed/i.test(m))
    return "连不上电脑上的服务。确认 run.bat 还在运行,手机也在同一个 Tailscale 网络里。";
  return (label ? label + ":" : "") + m;
}

/* 导入成功后只清掉写进去的那些行,解析失败/重复的行留在框里等你改。
   之前是整块 value = "",失败行跟着一起没,只能重打。 */
function keepFailedLines(sel, badRows) {
  const el = $(sel);
  if (!el) return;
  if (!badRows || !badRows.length) { el.value = ""; return; }
  el.value = badRows.map(r => r.raw || "").filter(Boolean).join("\n");
}

function busy(on, msg) {
  const b = $("#busy");
  if (!on) return b.classList.add("hidden");
  b.querySelector(".box").innerHTML =
    `<span class="spin"></span>${esc(msg || "处理中…")}`;
  b.classList.remove("hidden");
}

/* 滑块拖到哪都得有话可说 —— STRENGTH_LABEL 必须覆盖 -3..3 全部七个整数,
   缺一个就会显示成「0 undefined」。fittest.js 里钉了这条。 */
function strengthText(w) {
  return `${w > 0 ? "+" : ""}${w} ${STRENGTH_LABEL[w] || ""}`;
}

function strengthTag(w) {
  const cls = w > 0 ? "pos" : (w < 0 ? "neg" : "");
  return `<span class="tag ${cls}">${strengthText(w)}</span>`;
}

/* 尺寸走 class(默认 / .sm / .md),只有背景色是运行时算的 ——
   那是数据驱动的,必须内联。 */
function avatar(id, name, cls) {
  return `<div class="avatar blurable${cls ? " " + cls : ""}" ` +
    `style="background:${GraphView.nodeColor(id)}">${esc((name || "?")[0])}</div>`;
}

/* ---------------- 主题 ---------------- */

// 默认深色 —— 关系图在深底上才成立(发光、景深、弱化背景都只在深色下有意义)
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  // 必须和 --bg-0 一致,否则 iOS 状态栏和顶栏之间会有一条可见的色差缝
  if (meta) meta.setAttribute("content", t === "light" ? "#f4f6f8" : "#080c18");
  const b = $("#themeBtn");
  if (b) {
    // 图标表示"点了会变成什么",所以浅色时显示月亮。
    // 只改一个 href,不重建 DOM。
    const u = b.querySelector("use");
    if (u) u.setAttribute("href", t === "light" ? "#i-moon" : "#i-sun");
    b.setAttribute("aria-label", t === "light" ? "切换到深色主题" : "切换到浅色主题");
  }
}

function initTheme() {
  applyTheme(localStorage.getItem("theme") || "dark");
}

function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "light"
    ? "dark" : "light";
  localStorage.setItem("theme", next);
  applyTheme(next);
}

/* ---------------- 启动 ---------------- */

async function boot() {
  /* 双击 index.html 打开时地址是 file:///…,浏览器不让页面读数据,
     样式和脚本也加载不到。与其让人对着一堆报错发愣,不如直接说清楚。

     ⚠ 下面这段的内联样式是**有意的,不要清理**:它的前提就是
     style.css 没能加载成功,所以不能依赖任何类名。 */
  if (location.protocol === "file:") {
    const url = "http://127.0.0.1:8787/";
    document.body.innerHTML =
      '<div style="font:15px/1.9 -apple-system,\'Segoe UI\',system-ui,sans-serif;' +
      'max-width:620px;margin:60px auto;padding:0 22px;color:#1a1a1a">' +
      '<h2 style="font-size:19px;margin:0 0 14px">要通过服务打开,不能双击文件</h2>' +
      '<p style="margin:0 0 14px">你现在的地址是 <code>file:///…</code>。' +
      '这样打开时浏览器不允许页面读取数据,样式和脚本也加载不到。</p>' +
      '<p style="margin:0 0 8px">先双击运行 <code>run.bat</code>,然后打开:</p>' +
      '<p style="margin:0 0 20px"><a href="' + url + '" style="font-size:16px">' +
      url + '</a></p>' +
      '<p style="margin:0;color:#666;font-size:13.5px">' +
      '手机上是 <code>http://100.97.25.86:8787/</code>' +
      '(需和电脑在同一个 Tailscale 网络里)。</p></div>';
    return;
  }
  // 兜底:任何漏了 guard 的地方也不会再静默失败
  window.addEventListener("unhandledrejection", ev => {
    busy(false);
    toast(humanError(ev.reason));
    ev.preventDefault();
  });

  initTheme();
  /* 视觉强度档位。对比页已经定稿并删掉,默认就是用户选的 A 档。
     localStorage 里的 gstyle 只剩下"手工改一下试试"的用途,留着不碍事;
     B / C 还在 GraphStyles 里,但只作为 fittest 的测试基准。 */
  GraphView.setStyle(GraphStyles[localStorage.getItem("gstyle") || "A"]);
  GraphView.init({
    onNode: showPerson,
    onEdge: showPair,
    onBlank: closeSheets,
  });

  document.querySelectorAll(".navbtn").forEach(b => {
    b.onclick = () => switchView(b.dataset.view);
  });

  const paintMask = on => {
    $("#maskBtn").classList.toggle("on", on);
    $("#maskBtn").setAttribute("aria-pressed", on ? "true" : "false");
  };
  $("#maskBtn").onclick = () => {
    const on = document.body.classList.toggle("masked");
    paintMask(on);
    localStorage.setItem("masked", on ? "1" : "");
  };
  if (localStorage.getItem("masked")) {
    document.body.classList.add("masked");
    paintMask(true);
  }

  $("#circleBtn").onclick = toggleCircleMenu;
  document.addEventListener("click", e => {
    if (!e.target.closest("#circleBtn") && !e.target.closest("#circleMenu"))
      setCircleMenuOpen(false);
  });

  /* 复位 = 把拖过的球放回算法排的位置(拖动本就不持久化)+ 重新贴合视口。
     另外它还是**重新排布的显式出口**:手动加过关系之后图上是增量补丁
     (只多了一条线,球一个没动),想让算法按新关系重新摆一次就点这里。
     绝不在保存后偷偷重排 —— 用户刚录完一条,最想看的是那条线出现在哪,
     不是满屏重新洗牌。 */
  $("#fitBtn").onclick = () => {
    closeSheets();
    const restored = GraphView.resetPositions();
    if (S.patched) {
      S.patched = false;
      S.graphLoaded = false;
      loadGraph();                       // 里面会重新贴合
      toast("已按新关系重新排布");
      return;
    }
    GraphView.fit(bottomInset());
    if (restored) toast("已放回原来的位置");
  };
  $("#themeBtn").onclick = toggleTheme;
  // 派系着色的开关已挪到设置页(见 renderSettings 的「外观」卡片)
  S.byFaction = !!localStorage.getItem("byFaction");

  // 窗口尺寸变了可能跨到另一个画布档位,重新取一次
  let rz;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      if (S.view === "graph") { S.graphLoaded = false; loadGraph(); }
    }, 350);
  });

  // 撤销:整条 toast 都是热区
  $("#toast").onclick = () => {
    const fn = undoAction;
    hideToast();
    if (fn) fn();
  };
  $("#newPersonBtn").onclick = () => newPersonForm();
  /* 人物页的点击走一次事件委托,绑在这里绑一次就够。
     以前每一行拼一个 onclick="gotoPerson(id)" 字符串,而那一整块 innerHTML
     每敲一个键就要重建一遍 —— 现在列表只建一次,委托也就只需要挂一次。 */
  $("#peopleList").onclick = e => {
    const row = e.target.closest("[data-pid]");
    if (row) gotoPerson(+row.dataset.pid);
  };

  bindAiBar();
  watchAiBar();
  bindSheet();
  await refresh();          // 圈子在这里面就定好了,人也是按圈子取的
  paintCircleBtn();
  await loadGraph();
}

async function refresh() {
  S.state = await api("/api/state");
  /* 必须在取人之前把圈子定下来 —— cq() 读的就是 S.circle。
     首次启动时 S.circle 还是 null,拼出来是 "circle="(空),
     服务端把空值当"全部圈子",于是人物页列出全库的人
     (演示数据下:公司圈只有 19 人,列表却有 25 个)。 */
  const saved = +localStorage.getItem("circle");
  S.circle = (S.circle && S.state.circles.find(c => c.id === S.circle.id))
    || S.state.circles.find(c => c.id === saved)
    || S.state.circles[0]
    || null;
  S.people = (await api("/api/people?" + cq())).people;
}

function switchView(name) {
  S.view = name;
  closeSheets();
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
  document.querySelectorAll(".navbtn").forEach(b => {
    const on = b.dataset.view === name;
    b.classList.toggle("on", on);
    if (on) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });
  $("#aibar").classList.toggle("hidden", name !== "graph");
  $("#fitBtn").classList.toggle("hidden", name !== "graph");
  measureAiBar();          // 显隐变了,图例的落点要跟着变

  if (name === "graph" && !S.graphLoaded) loadGraph();
  if (name === "situation") renderSituation();
  if (name === "people") renderPeople();
  if (name === "settings") renderSettings();
}

/* ---------------- 圈子切换 ---------------- */

function paintCircleBtn() {
  const c = S.circle;
  $("#circleBtn").innerHTML =
    `<span class="ico">${esc(c ? c.icon || "🌐" : "🌐")}</span>` +
    `<span class="nm">${esc(c ? c.name : "全部")}</span>` +
    `<svg class="ic sm caret" aria-hidden="true"><use href="#i-caret"/></svg>`;
}

function setCircleMenuOpen(open) {
  $("#circleMenu").classList.toggle("hidden", !open);
  $("#circleBtn").setAttribute("aria-expanded", open ? "true" : "false");
}

function toggleCircleMenu(e) {
  e.stopPropagation();
  const m = $("#circleMenu");
  if (!m.classList.contains("hidden")) return setCircleMenuOpen(false);

  m.innerHTML =
    S.state.circles.map(c => `
      <button class="cmenu-item ${S.circle && c.id === S.circle.id ? "on" : ""}"
              data-cid="${c.id}">
        <span class="ico">${esc(c.icon || "🌐")}</span>
        <span>${esc(c.name)}</span>
        <span class="sub">${c.people} 人 · ${c.relations} 条</span>
      </button>`).join("") +
    `<div class="cmenu-sep"></div>
     <button class="cmenu-item" data-act="new">
       <svg class="ic sm ico" aria-hidden="true"><use href="#i-plus"/></svg>
       <span>新建圈子</span></button>
     <button class="cmenu-item" data-act="manage">
       <svg class="ic sm ico" aria-hidden="true"><use href="#i-gear"/></svg>
       <span>管理圈子</span></button>`;

  m.querySelectorAll("[data-cid]").forEach(b => {
    b.onclick = () => {
      setCircleMenuOpen(false);
      switchCircle(+b.dataset.cid);
    };
  });
  m.querySelector('[data-act="new"]').onclick = () => {
    setCircleMenuOpen(false); newCircle();
  };
  m.querySelector('[data-act="manage"]').onclick = () => {
    setCircleMenuOpen(false); switchView("settings");
  };
  setCircleMenuOpen(true);
}

async function switchCircle(cid) {
  S.circle = S.state.circles.find(c => c.id === cid);
  localStorage.setItem("circle", cid);
  paintCircleBtn();
  S.graphLoaded = false;
  closeSheets();
  await refresh();
  if (S.view === "graph") loadGraph();
  if (S.view === "situation") renderSituation();
  if (S.view === "people") renderPeople();
}

async function newCircle() {
  const name = prompt("新圈子叫什么?(比如:公司圈、同学圈、老家亲戚)");
  if (!name) return;
  const kinds = Object.keys(S.state.circle_kinds);
  const kind = prompt(`类型?可选:${kinds.join(" / ")}\n(决定优先推荐哪些关系类型)`,
                      "自定义") || "自定义";
  const icon = prompt("给它个图标(一个 emoji,可留空)", "🌐") || "🌐";
  const r = await api("/api/circles", { name, kind, icon });
  await refresh();
  await switchCircle(r.id);
  toast("圈子建好了");
}

/* ---------------- 图谱 ---------------- */

async function loadGraph() {
  try {
    const g = await api(`/api/graph?${cq()}&aspect=${viewAspect()}`);
    const empty = $("#graphEmpty");
    if (!g.nodes.length) {
      empty.classList.remove("hidden");
      $("#legend").classList.add("hidden");
      document.getElementById("svg").innerHTML = "";
      return;
    }
    empty.classList.add("hidden");
    $("#legend").classList.remove("hidden");
    GraphView.render(g);
    GraphView.setFactionMode(S.byFaction);
    S.graph = g;
    requestAnimationFrame(() => GraphView.fit(bottomInset()));
    S.graphLoaded = true;
    paintLegend();
  } catch (e) {
    toast(e.message);
  }
}

function paintLegend() {
  const g = S.graph;
  if (!g) return;
  $("#legend").innerHTML =
    `<span class="k">${g.nodes.length} 人 · ${g.edges.length} 条关系</span><br>` +
    `<span class="k"><i class="sw pos"></i>正向</span>` +
    `<span class="k"><i class="sw neg"></i>负向</span>` +
    (g.edges.some(e => e.mixed)
      ? `<span class="k"><i class="sw mix"></i>⚡ 又好又对立</span>` : "") +
    (S.byFaction ? `<span class="k">节点颜色 = 派系</span>`
                 : `<span class="k">节点亮度 = 重要程度</span>`);
}

/* ---------------- 卡片:统一的开关 ----------------
   所有关闭路径(✕ / Esc / 点遮罩 / 下拉 / onBlank)最终都汇到 dialog 的
   close 事件,清理逻辑因此只写一份。 */

let sheetClosing = false;

function openSheet(html, label) {
  const dlg = $("#sheet");
  const body = $("#sheetBody");
  body.innerHTML = html;
  bindSegs(body);
  if (label) dlg.setAttribute("aria-label", label);
  if (!dlg.open) {
    // showModal() 对已经打开的 dialog 会抛 InvalidStateError,
    // 而"人物卡里点一条关系 → 打开连线卡"正是在已开状态下调的
    sheetClosing = false;
    dlg.classList.remove("closing");
    const card0 = dlg.querySelector(".sheet-card");
    if (card0) card0.style.transform = "";
    dlg.showModal();
  }
}

/* 卡片里的分段切换。翻的是容器上的一个 data 属性,逐段的显隐交给 CSS ——
   不重建 DOM,所以切回来时滚动位置和已展开的内容都还在。 */
function bindSegs(root) {
  const bar = root.querySelector(".seg");
  if (!bar) return;
  const body = root.querySelector(".seg-body");
  bar.addEventListener("click", e => {
    const b = e.target.closest(".seg-btn");
    if (!b) return;
    bar.querySelectorAll(".seg-btn").forEach(x => {
      const on = x === b;
      x.classList.toggle("on", on);
      x.setAttribute("aria-selected", on ? "true" : "false");
    });
    body.dataset.on = b.dataset.seg;
  });
}

function closeSheets() {
  const dlg = $("#sheet");
  if (!dlg || !dlg.open || sheetClosing) return;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return dlg.close();
  sheetClosing = true;
  dlg.classList.add("closing");
  dlg.addEventListener("animationend", () => dlg.close(), { once: true });
}

function bindSheet() {
  const dlg = $("#sheet");

  dlg.addEventListener("close", () => {
    sheetClosing = false;
    dlg.classList.remove("closing", "dragging");
    const c = dlg.querySelector(".sheet-card");
    if (c) c.style.transform = "";
    // toast 可能被搬进了这个 dialog,卡片一关它会跟着消失 —— 搬回去
    const tst = document.getElementById("toast");
    if (tst && tst.parentNode === dlg) document.body.appendChild(tst);
    $("#sheetBody").innerHTML = "";
    GraphView.focus(null);
  });

  // 点遮罩关闭:点 ::backdrop 时 event.target 就是 dialog 本身
  // (前提是 dialog 自己 padding:0,否则内边距区域也会命中它)
  dlg.addEventListener("click", e => { if (e.target === dlg) closeSheets(); });
  $("#sheetClose").onclick = () => closeSheets();

  /* 把手以前画了个可拖的样子却什么都不做 —— 比没有更糟。真绑上。
     只写 transform,走合成层。 */
  const card = dlg.querySelector(".sheet-card");
  const head = dlg.querySelector(".sheet-head");
  let y0 = 0, dy = 0, on = false;
  head.addEventListener("touchstart", e => {
    if (e.touches.length !== 1) return;
    on = true; dy = 0; y0 = e.touches[0].clientY;
    dlg.classList.add("dragging");
  }, { passive: true });
  head.addEventListener("touchmove", e => {
    if (!on) return;
    dy = Math.max(0, e.touches[0].clientY - y0);   // 只能往下拉
    card.style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  head.addEventListener("touchend", () => {
    if (!on) return;
    on = false;
    dlg.classList.remove("dragging");
    if (dy > 90) return closeSheets();
    card.style.transform = "";                     // 没拉够,弹回去
  });
}

/* ---------------- 人物卡片(四个分析折叠在这里) ---------------- */

async function showPerson(pid) {
  GraphView.focus(pid);
  openSheet('<div class="dimtext">载入中…</div>');

  let d, b;
  try {
    [d, b] = await Promise.all([
      api(`/api/person?id=${pid}&` + cq()),
      api(`/api/analysis/brief?id=${pid}&` + cq()),
    ]);
  } catch (e) { openSheet(`<div class="warnbox">${esc(e.message)}</div>`); return; }

  const p = d.person;

  const rels = d.relations.map(r => {
    const otherId = r.a_id === pid ? r.b_id : r.a_id;
    const other = r.a_id === pid ? r.b_name : r.a_name;
    const dir = r.directed
      ? (r.a_id === pid ? " →" : " ←") : "";
    /* 这一行整条都要打码,不只是名字:关系类型本身就很敏感(「情敌」),
       而备注是全库最敏感的一行 ——「情敌 · 去年年会上为了同一个人吵起来」
       就是从这里印出来的。以前只有上面那个 .nm 带 blurable。 */
    return `<div class="row" onclick="showPair(${pid},${otherId})">
      ${avatar(otherId, other, "sm")}
      <div class="main">
        <div class="nm blurable">${esc(other)}</div>
        <div class="meta blurable">${esc(r.glyph || "")} ${esc(r.kind)}${dir}${
          r.notes ? " · " + esc(r.notes) : ""}</div>
      </div>${strengthTag(r.strength)}</div>`;
  }).join("") || '<div class="dimtext">这个圈子里还没记录他的关系</div>';

  // ---- 敌人的敌人 ----(呈现规则见 allyRows)
  const alliesHtml = allyRows((b.allies && b.allies.candidates || []).slice(0, 6));

  // ---- 引荐路径 ----
  const intro = b.intro && b.intro.path
    ? `<div class="card"><div class="blurable">
         ${b.intro.path.map(s => esc(s.name)).join(" → ")}</div>
       <div class="hint">${b.intro.hops} 跳,优先走交情最铁的链路</div></div>`
    : `<div class="card"><div class="dimtext">${
        esc((b.intro && b.intro.reason) || "还没设置「我是谁」,去设置页指定一下")}</div></div>`;

  // ---- 派系 ----
  const fac = b.faction ? `<div class="card">
      <div>圈内共 ${b.faction.size} 人,核心是
        <b class="blurable">${esc(b.faction.core ? b.faction.core.name : "—")}</b></div>
      <div style="margin-top:6px">${b.faction.members.slice(0, 14).map(m =>
        `<span class="tag blurable">${esc(m.name)}</span>`).join("")}</div>
      ${b.same_faction_as_me ? '<div class="hint">你和他在同一个派系里。</div>' : ""}
    </div>` : "";

  // ---- 不稳定三角 ----
  const tris = (b.triangles && b.triangles.triangles || []).slice(0, 4).map(t => `
    <div class="card">
      <div class="blurable"><b>${t.members.map(m => esc(m.name)).join(" — ")}</b></div>
      <div class="meta dimtext">${esc(t.pattern)} · 撬动价值 ${t.leverage}</div>
      <div class="hint blurable">${esc(t.hint)}</div>
    </div>`).join("") || '<div class="dimtext">他周围没有不稳定的三角</div>';

  openSheet(`
    <div class="head">
      ${avatar(pid, p.name)}
      <div class="grow">
        <h3 class="blurable">${esc(p.name)}${p.is_me ? ' <span class="tag">我</span>' : ""}</h3>
        <!-- 部门职位也得打码:「技术部 · CTO」在一个 19 人的圈子里
             基本等同于点名,和名字一样是可识别信息。 -->
        <div class="sub blurable">${esc(p.dept || "")} ${esc(p.title || "")}</div>
      </div>
    </div>
    <div style="margin-bottom:10px">${d.circles.map(c =>
      `<span class="tag">${esc(c.icon || "")} ${esc(c.name)}</span>`).join("")}</div>

    <!-- 分成三段。以前这些全叠在一个面板里,人物卡片长到两千多像素,
         想看事件要一路滚过关系、拉拢名单、引荐路径、派系、三角。
         切换只翻 .seg-body 上的一个 data 属性,显隐交给 CSS。 -->
    <div class="seg" role="tablist">
      <button class="seg-btn on" data-seg="rel" role="tab">关系 ${d.relations.length}</button>
      <button class="seg-btn" data-seg="ana" role="tab">分析</button>
      <button class="seg-btn" data-seg="evt" role="tab">事件 ${d.events.length}</button>
    </div>

    <div class="seg-body" data-on="rel">
      <div data-seg="rel">
        <!-- 段头右侧的 ＋ 是全 app 价值最高的一个入口:A 已经填好了,
             用户只需要选 B。从图上点开一个人再补一条关系是最自然的路径。 -->
        <div class="hstack">
          <div class="sec grow">这个圈子里的关系</div>
          <button class="btn mini" onclick="openRelForm({a:${pid}})">＋ 加一条</button>
        </div>
        <div class="list">${rels}</div>
      </div>

      <div data-seg="ana">
        <div class="sec">可以拉拢谁对付他</div>
        ${alliesHtml}

        <div class="sec">我该托谁引荐</div>${intro}

        ${fac ? '<div class="sec">他所在的派系</div>' + fac : ""}

        <div class="sec">他周围的不稳定三角</div>${tris}
      </div>

      <div data-seg="evt">
        ${d.events.slice(0, 20).map(e => `<div class="card">
            <div class="blurable">${esc(e.text)}</div>
            <div class="hint">${new Date(e.happened_at * 1000).toLocaleDateString("zh-CN")}
              ${e.source ? " · " + esc(e.source) : ""}</div></div>`).join("")
          || '<div class="dimtext empty-line">还没有相关事件</div>'}
      </div>
    </div>

    <div class="btn-row">
      <button class="btn" onclick="markMe(${pid})">设为「我」</button>
      <button class="btn danger" onclick="delPerson(${pid})">删除此人</button>
    </div>`);
}

/* ---------------- 连线卡片:两个人之间的故事 ---------------- */

async function showPair(a, b) {
  GraphView.focusEdge(a, b);
  openSheet('<div class="dimtext">载入中…</div>');

  let d;
  try {
    d = await api(`/api/pair?a=${a}&b=${b}&` + cq());
  } catch (e) { openSheet(`<div class="warnbox">${esc(e.message)}</div>`); return; }
  S.pair = d;      // 改 / 换类型 / 删 全按下标取原始行,不往 onclick 里拼字符串

  /* 三个按钮传的都是**下标**而不是把 kind/notes 拼进 onclick 属性 ——
     备注里随便一个引号就能把整个属性拆掉,而那种错只在点下去时才现形。 */
  const rels = d.relations.map((r, i) => {
    // 方向那一行里是**两个真名**,和别处一样要打码
    const dir = r.directed
      ? `<div class="meta blurable">方向:${esc(r.a_name)} → ${
          esc(r.b_name)}</div>` : "";
    return `<div class="card">
      <div class="hstack wrap">
        <span class="glyph">${esc(r.glyph || "")}</span>
        <b>${esc(r.kind)}</b>${strengthTag(r.strength)}
        <span class="spacer"></span>
        <button class="btn mini" onclick="editRelation(${i})">改</button>
        <button class="btn mini" onclick="swapRelation(${i})">换类型</button>
        <button class="btn danger mini" onclick="delRelation(${i})">删</button>
      </div>
      ${dir}
      ${r.notes ? `<div class="evidence blurable">${esc(r.notes)}</div>` : ""}
    </div>`;
  }).join("") || '<div class="dimtext">这个圈子里他们之间还没有记录关系</div>';

  const stories = d.stories.map(s => `
    <div class="card">
      <div class="blurable">${esc(s.text)}</div>
      <div class="hint">${new Date(s.happened_at * 1000).toLocaleDateString("zh-CN")}
        ${s.source ? " · " + esc(s.source) : ""}</div>
    </div>`).join("") || '<div class="dimtext">还没有记录他们之间的故事</div>';

  openSheet(`
    <div class="head">
      ${avatar(a, d.a.name, "md")}
      <span class="dimtext glyph">—</span>
      ${avatar(b, d.b.name, "md")}
      <div class="grow">
        <h3 class="blurable">${esc(d.a.name)} 与 ${esc(d.b.name)}</h3>
      </div>
    </div>

    <div class="sec">他们之间的关系</div>${rels}
    <div class="btn-row">
      <button class="btn" onclick="openRelForm({a:${a},b:${b}})">＋ 再加一条</button>
    </div>

    <div class="sec">故事(${d.stories.length})</div>${stories}

    <label>再记一笔</label>
    <textarea id="pairStory" class="compact"
      placeholder="例:去年年会上两人当众吵了一架,之后再没同框过。"></textarea>
    <div class="btn-row">
      <button class="btn primary" onclick="addPairStory(${a},${b})">保存这段故事</button>
    </div>`);
}

async function addPairStory(a, b) {
  const text = $("#pairStory").value.trim();
  if (!text) return toast("先写点内容");
  await api("/api/pair/story", { a, b, text, circle_id: S.circle.id });
  toast("记下了");
  showPair(a, b);
}

/* ============================================================
   手动录入:加人 / 加关系 / 改强度 / 记一笔
   ============================================================

   POST /api/people、/api/relations、/api/events 这三个接口一直都在,
   前端一次都没调过 —— 于是 UI 上根本没有手动建人、建关系、改强度的入口:
   两个人之间只要还没有边,就找不到任何地方能记录他们的关系。

   要用的词表全在 /api/state 里躺着:kinds(26 种类型 + 默认强度 + 是否有向)、
   categories(6 个类别)、category_glyph、circle_kinds(圈子类型 → 优先类别)。
   **零个新接口、零次额外往返。**

   所有写操作全程 await 串行,而且**绝不后台预热 /api/graph**:
   它是个会写库的 GET(_save_seed / cache_put),而 db 是全进程一个 sqlite
   连接、tx() 直接在共享连接上 commit()、服务是 ThreadingHTTPServer ——
   让它和用户的 POST 并发,一个线程的 commit() 会把另一个线程写了一半的
   事务一起提交。现有代码没炸靠的就是前端串行,新功能必须继续串行。 */

// 表单状态。放模块级而不是挂 DOM 上:卡片内容是整块 innerHTML 重建的,
// 挂在元素上的状态一重建就没了。
const F = {
  mode: "create",     // create 新建 / edit 只改强度 / swap 换类型
  a: null, b: null,   // 选中的两个人
  cat: "", kind: "",
  strength: 0,
  dir: "ab",          // 有向关系时谁是 a_id 那一侧
  notes: "",
  relId: null,        // edit 要改的、swap 要替换掉的那条
  oldKind: "",        // swap 时被替换掉的类型名(警告框里要点名)
  existing: [],       // 这两人之间已有的全部关系
  open: null,         // 当前展开的选人面板
  q: "",              // 选人面板里的搜索词
  people: [],         // 「记一笔」选中的人
  text: "",
};

/* 写操作的串行闸。**不是防手抖,是防并发**:db 是全进程一个 sqlite 连接、
   tx() 在共享连接上直接 commit(),两个 POST 同时进来,一个线程的 commit()
   会把另一个线程写了一半的事务一起提交。现有代码没炸靠的就是前端全程串行。

   而 #busy 这层忙碌遮罩在这里指望不上:卡片是 <dialog>,showModal() 之后它在
   top layer 里,普通元素的 z-index 再高也盖不住 —— 连点两下第二下照样进得来。 */
let writing = false;

function personById(id) {
  return S.people.find(p => p.id === id) || null;
}

/* 默认展开哪个类别。circle_kinds 是**为这件事造的字段,前端一次没用过**:
   公司圈 → 职场,同学圈 → 学缘。26 个类型一次全铺出来谁也扫不完。 */
function defaultCat() {
  const st = S.state;
  const prefer = (st.circle_kinds || {})[S.circle ? S.circle.kind : ""] || [];
  return prefer[0] || st.categories[0];
}

function kindInfo(k) {
  return (S.state.kinds || {})[k] || null;
}

function isDirected(k) {
  const i = kindInfo(k);
  return !!(i && i.directed === 1);
}

// 有向关系里谁在 a_id 那一侧(师傅 / 提携者 / 上级 / 暗恋者 / 出借方)
function orderedPair() {
  if (isDirected(F.kind) && F.dir === "ba") return [F.b, F.a];
  return [F.a, F.b];
}

/* 这两人之间是不是已经有一条同 kind 的关系。
   有的话保存就是 UPDATE 而不是 INSERT —— 这件事必须在点下去**之前**看得见。 */
function existingSame() {
  if (!F.kind || !F.a || !F.b) return null;
  const p = orderedPair();
  return (F.existing || []).find(r => r.kind === F.kind &&
    (!isDirected(F.kind) || (r.a_id === p[0] && r.b_id === p[1]))) || null;
}

/* ---------------- 选人:自建的带搜索下拉 ----------------
   **不用原生 <select>** —— iOS 上 100 个 option 是一个只能盲滚的滚轮,
   既看不见部门也搜不了。这里就地展开一个搜索框 + 列表,不做浮层,
   省掉一整套定位、遮挡、点外面关闭的处理。 */

function pickerHtml(slot, label, selId) {
  const p = selId ? personById(selId) : null;
  const open = F.open === slot;
  return `
    <label>${esc(label)}</label>
    <div class="row" data-pick="${slot}">
      ${p ? avatar(p.id, p.name, "sm") : '<span class="glyph dimtext">＋</span>'}
      <div class="main">
        <div class="nm blurable">${p ? esc(p.name) : "选一个人"}</div>
        ${p ? `<div class="meta blurable">${esc(p.dept || "—")} ${
          esc(p.title || "")}</div>` : ""}
      </div>
      <span class="dimtext">${open ? "收起" : "›"}</span>
    </div>
    <div data-panel="${slot}"${open ? "" : ' class="hidden"'}>
      <input class="input" data-q="${slot}" placeholder="搜姓名 / 部门 / 职位"
             autocomplete="off" value="${esc(F.q)}">
      <div class="list" data-plist="${slot}"
           style="max-height:210px;overflow:auto;overscroll-behavior:contain;margin-top:8px"></div>
    </div>`;
}

/* 只重画列表,不重画搜索框 —— 搜索框一重建,中文输入法正在拼的那一半
   就会被打断。人物页的 renderPeople 也是这么处理的。 */
function paintPickList(slot) {
  const box = $(`#sheetBody [data-plist="${slot}"]`);
  if (!box) return;
  const raw = (F.q || "").trim();
  const q = raw.toLowerCase();
  const skip = slot === "e" ? F.people : [slot === "a" ? F.b : F.a];
  // 和人物页共用 searchKey() —— 两处各写一份的话,同一个关键词在两个地方
  // 搜出不同结果,而用户只会以为是数据坏了
  let list = S.people.filter(p => !q || searchKey(p).includes(q));
  list = list.filter(p => !skip.includes(p.id));
  // 空查询按 updated_at 倒序:连着录十条时,刚碰过的人就在最上面,省打字
  if (!q) list = list.slice().sort((x, y) => (y.updated_at || 0) - (x.updated_at || 0));

  const rows = list.slice(0, 60).map(p => `
    <div class="row" data-pid="${p.id}">
      ${avatar(p.id, p.name, "sm")}
      <div class="main">
        <div class="nm blurable">${esc(p.name)}</div>
        <div class="meta blurable">${esc(p.dept || "—")} ${esc(p.title || "")}</div>
      </div>
    </div>`).join("");
  // 「＋ 新建「张三」」这一行**就是加人入口** —— 录关系时发现库里没这个人,
  // 不必退出去建完再回来
  const dup = S.people.some(p => p.name === raw);
  const create = raw && !dup
    ? `<div class="row" data-new="1"><span class="glyph">＋</span>
         <div class="main"><div class="nm">新建「${esc(raw)}」</div>
         <div class="meta">建好之后直接选上</div></div></div>` : "";
  box.innerHTML = (create + rows) ||
    '<div class="dimtext empty-line">没有匹配的人,打个名字就能新建</div>';
}

function bindPicker(slot, onPick) {
  const trig = $(`#sheetBody [data-pick="${slot}"]`);
  if (trig) trig.onclick = () => {
    F.open = F.open === slot ? null : slot;
    F.q = "";
    rerenderForm();
  };
  const box = $(`#sheetBody [data-q="${slot}"]`);
  if (box) box.oninput = () => { F.q = box.value; paintPickList(slot); };
  const list = $(`#sheetBody [data-plist="${slot}"]`);
  if (list) list.onclick = ev => {
    const add = ev.target.closest("[data-new]");
    if (add) return createPersonInline((F.q || "").trim(), onPick);
    const row = ev.target.closest("[data-pid]");
    if (row) onPick(+row.dataset.pid);
  };
  paintPickList(slot);
}

/* 从选人面板里就地建人:只要一个名字。部门职位以后在人物卡里补 ——
   录关系录到一半被拉去填一整张表单,十有八九就把原来要录的事忘了。 */
async function createPersonInline(name, onPick) {
  if (!name) return toast("先打个名字");
  if (writing) return;
  writing = true;
  busy(true, "新建中…");
  try {
    const r = await api("/api/people", { name, circle_id: S.circle.id });
    S.graphLoaded = false;        // 图上多了个人 → 这次必须整张重排
    await refresh();
    busy(false);
    toast(`已新建「${name}」`);
    onPick(r.id);
  } catch (e) { busy(false); toast(humanError(e, "新建人物失败")); }
  finally { writing = false; }
}

/* ---------------- 加人(完整表单) ---------------- */

function newPersonForm() {
  openSheet(`
    <h3>新建人物</h3>
    <div class="sub">会加进「${esc(S.circle.name)}」。只有姓名是必填的。</div>
    <label>姓名</label>
    <input class="input" id="npName" autocomplete="off" placeholder="张三">
    <label>部门</label>
    <input class="input" id="npDept" autocomplete="off" placeholder="技术部">
    <label>职位</label>
    <input class="input" id="npTitle" autocomplete="off" placeholder="后端工程师">
    <div class="btn-row">
      <button class="btn primary" id="npSave">保存</button>
      <button class="btn" onclick="closeSheets()">取消</button>
    </div>
    <div class="hint">同名的人会被认成同一个 —— 库里已有「张三」时,
      这里再建一个「张三」只会更新那一条,不会多出一个孤立的球。</div>`, "新建人物");
  $("#npSave").onclick = savePerson;
}

async function savePerson() {
  const name = $("#npName").value.trim();
  if (!name) return toast("姓名不能为空");
  if (writing) return;
  writing = true;
  busy(true, "写入中…");
  try {
    await api("/api/people", {
      name, dept: $("#npDept").value.trim(), title: $("#npTitle").value.trim(),
      circle_id: S.circle.id,
    });
    S.graphLoaded = false;        // 节点集合变了,只能整张重排
    await refresh();
    busy(false);
    closeSheets();
    await loadGraph();
    if (S.view === "people") renderPeople();
    toast(`已加入「${S.circle.name}」`);
  } catch (e) { busy(false); toast(humanError(e, "新建人物失败")); }
  finally { writing = false; }
}

/* ---------------- 加关系 / 改强度 / 换类型 ---------------- */

async function openRelForm(opts) {
  const o = opts || {};
  F.mode = o.mode || "create";
  F.a = o.a || null;
  F.b = o.b || null;
  F.kind = o.kind || "";
  F.relId = o.relId || null;
  F.oldKind = o.oldKind || "";      // 换类型时警告框里要点名的那条
  F.dir = o.dir || "ab";
  F.notes = o.notes || "";
  F.strength = o.strength == null ? 0 : o.strength;
  F.cat = F.kind ? (kindInfo(F.kind) || {}).cat || defaultCat() : defaultCat();
  // 缺谁就先把谁的选人面板摊开:从人物卡进来时 A 已经填好了,
  // 直接展开 B 那一栏,省掉一次"点开下拉"的空点击
  F.open = F.mode === "create" ? (!F.a ? "a" : (!F.b ? "b" : null)) : null;
  F.q = "";
  F.existing = [];
  openSheet('<div class="dimtext">载入中…</div>');
  await loadExisting();
  // 新建时如果已经有同 kind 的关系,滑块预置成现有强度 —— 这样"保存"
  // 到底是新增还是覆盖,在点之前就看得出来
  if (F.mode === "create" && F.kind) {
    const ex = existingSame();
    if (ex) F.strength = ex.strength;
  }
  renderRelForm();
}

async function loadExisting() {
  if (!F.a || !F.b) { F.existing = []; return; }
  const d = await api(`/api/pair?a=${F.a}&b=${F.b}&` + cq());
  F.existing = d.relations || [];
}

// 卡片里正在显示哪张表单 —— 选人面板收起/展开要重画整张
let formKind = "rel";
function rerenderForm() {
  if (formKind === "evt") renderEventForm();
  else renderRelForm();
}

// 重画之前先把用户已经敲进去的东西收回状态里,否则一点 chip 就白打了
function syncRelForm() {
  const n = $("#relNotes");
  if (n) F.notes = n.value;
  const s = $("#relStr");
  if (s) F.strength = +s.value;
}

function chip(attr, val, text, on) {
  return `<button class="btn mini${on ? " primary" : ""}" ${attr}="${val}">${text}</button>`;
}

function renderRelForm() {
  formKind = "rel";
  const st = S.state;
  const a = personById(F.a), b = personById(F.b);
  const locked = F.mode === "edit";       // 「改」锁死类型,永远走 UPDATE
  const cat = F.cat || defaultCat();
  const kinds = Object.keys(st.kinds).filter(k => st.kinds[k].cat === cat);
  const ex = existingSame();
  const info = kindInfo(F.kind);

  const catRow = st.categories.map(c =>
    chip("data-cat", c, `${esc(st.category_glyph[c] || "")} ${esc(c)}`,
         c === cat)).join("");
  const kindRow = kinds.map(k =>
    chip("data-kind", k, esc(k) + (st.kinds[k].directed ? " →" : ""),
         k === F.kind)).join("");

  /* 方向 chip 用**真名**不用 A/B:「陈国栋 → 李明远」一眼就知道谁提携谁,
     「A → B」还得回头去看谁是 A。

     「改」这条路径上方向也是只读的:upsert 的键是 (circle, a, b, kind),
     a/b 换个位置就是**另一条记录** —— 在"只改强度"里把方向调过来,
     结果会是凭空多出一条反向的关系。方向和类型一样属于身份,不属于程度。 */
  const dirRow = !(isDirected(F.kind) && a && b) ? "" : locked ? `
    <label>方向</label>
    <div class="card"><span class="blurable">${esc(a.name)} → ${esc(b.name)}</span>
      <div class="hint">方向和类型一样是这条记录的身份,「改」不动它。
        要调头得走「换类型」重记一条。</div>
    </div>` : `
    <label>方向(${esc(F.kind)}是有方向的)</label>
    <div class="hstack wrap">
      ${chip("data-dir", "ab", `${esc(a.name)} → ${esc(b.name)}`, F.dir === "ab")}
      ${chip("data-dir", "ba", `${esc(b.name)} → ${esc(a.name)}`, F.dir === "ba")}
    </div>`;

  const title = F.mode === "edit" ? "改强度"
    : F.mode === "swap" ? "换关系类型" : "记一条关系";

  /* 换类型必须显式警告:upsert_relation 的键是 (circle, a, b, kind),
     同 kind 是 UPDATE,**换 kind 是 INSERT 而且旧的那条还在**,
     而聚合会把一对人之间所有 kind 的强度相加。用户以为"把同事改成竞争",
     实际得到 同事+1 和 竞争-2 两条,合起来是 -1。这是数据质量问题,不是 UI 瑕疵。 */
  const warn = F.mode === "swap" ? `
    <div class="warnbox">换类型 = <b>删掉「${esc(F.oldKind)}」再新建一条</b>,
      不是把原来那条改个名字。<br>
      执行顺序是先建后删 —— 万一中途失败,你会看到两条(删得掉),
      而不是一条都不剩。</div>` : "";

  const lockBox = locked ? `
    <div class="card">
      <div class="hstack">
        <span class="glyph">${esc(st.category_glyph[(info || {}).cat] || "")}</span>
        <b>${esc(F.kind)}</b><span class="tag">类型已锁定</span>
      </div>
      <div class="hint">「改」只动强度,永远是同一条记录的 UPDATE。
        要变成另一种关系,请回上一张卡片点「换类型」—— 那是删一条建一条,
        两回事。</div>
    </div>` : "";

  const mainLabel = locked ? "保存强度"
    : F.mode === "swap" ? `换成「${esc(F.kind || "…")}」`
    : ex ? `更新现有的「${esc(F.kind)}」(当前 ${strengthText(ex.strength)})`
    : "保存";

  openSheet(`
    <h3>${title}</h3>
    ${warn}
    ${locked || F.mode === "swap"
      ? `<div class="head">${avatar(F.a, a ? a.name : "?", "sm")}
           <span class="dimtext glyph">—</span>
           ${avatar(F.b, b ? b.name : "?", "sm")}
           <div class="grow"><h3 class="blurable">${esc(a ? a.name : "?")} 与 ${
             esc(b ? b.name : "?")}</h3></div></div>`
      : pickerHtml("a", "谁", F.a) + pickerHtml("b", "和谁", F.b)}

    ${lockBox || `
    <label>关系类型</label>
    <div class="hstack wrap">${catRow}</div>
    <div class="hstack wrap">${kindRow}</div>`}

    <label>强度 <b id="strVal">${esc(strengthText(F.strength))}</b></label>
    <input type="range" id="relStr" min="-3" max="3" step="1"
           value="${F.strength}">

    ${dirRow}

    <label>备注(可选)</label>
    <textarea id="relNotes" class="compact"
      placeholder="例:去年年会为了同一个项目吵过。">${esc(F.notes)}</textarea>

    <div class="btn-row">
      <button class="btn primary" id="relSave"${F.kind ? "" : " disabled"}>${
        mainLabel}</button>
      <button class="btn" id="relCancel">取消</button>
    </div>
    ${F.mode === "create" && ex ? `<div class="hint">他们之间已经有一条
      「${esc(F.kind)}」了,保存是把它改成新强度,不会多出一条。</div>` : ""}`,
    title);

  if (!locked && F.mode !== "swap") {
    bindPicker("a", id => { F.a = id; afterPick(); });
    bindPicker("b", id => { F.b = id; afterPick(); });
  }
  $("#sheetBody").querySelectorAll("[data-cat]").forEach(el => {
    el.onclick = () => { syncRelForm(); F.cat = el.dataset.cat; renderRelForm(); };
  });
  $("#sheetBody").querySelectorAll("[data-kind]").forEach(el => {
    el.onclick = () => { syncRelForm(); pickKind(el.dataset.kind); };
  });
  $("#sheetBody").querySelectorAll("[data-dir]").forEach(el => {
    el.onclick = () => { syncRelForm(); F.dir = el.dataset.dir; renderRelForm(); };
  });
  const sl = $("#relStr");
  sl.oninput = () => {
    F.strength = +sl.value;
    $("#strVal").textContent = strengthText(F.strength);
  };
  $("#relSave").onclick = saveRelation;
  $("#relCancel").onclick = () => {
    if (F.a && F.b) showPair(F.a, F.b); else closeSheets();
  };
}

/* 选中类型时强度自动跳到这个类型的默认值 —— 绝大多数录入因此是
   「选类别 → 选类型 → 存」三下。已经有同 kind 关系的话改用现有强度。 */
function pickKind(k) {
  F.kind = k;
  const ex = existingSame();
  F.strength = ex ? ex.strength : kindInfo(k).default;
  if (ex && !F.notes) F.notes = ex.notes || "";
  renderRelForm();
}

async function afterPick() {
  F.open = null;
  F.q = "";
  renderRelForm();              // 先把选中的人画出来,别等网络
  await loadExisting();
  if (F.kind) {
    const ex = existingSame();
    if (ex) F.strength = ex.strength;
  }
  renderRelForm();
}

/* 存完 / 删完之后统一走这里:重新取一次这两人的关系,算出这条边**该**长什么样。

   两个已有节点之间加边 = 只补一条边,**布局一动不动**。
   节点坐标只取决于"这个圈子里有哪些人",跟"他俩之间多了一条边"
   在一次增量里毫无关系。重排一次 ~580ms 而且所有球都会动 ——
   用户刚录完一条,最想看的是那条线出现在哪,不是满屏重新洗牌。 */
async function syncPairEdge(a, b) {
  const pair = await api(`/api/pair?a=${a}&b=${b}&` + cq());
  const agg = GraphRender.pairAggregate(pair.relations, S.state.category_glyph);
  // S.graphLoaded 为假 = 图还没画过,或者刚建了新人(节点集合变了)。
  // upsertEdge 返回 false = 有一端还不在图上。两种情况都只能整张重排。
  const patched = S.graphLoaded && GraphView.upsertEdge(a, b, agg);
  if (patched) {
    S.patched = true;           // 复位键因此变成"按新关系重新排布"的出口
    paintLegend();
  } else {
    S.graphLoaded = false;
  }
  return pair;
}

async function saveRelation() {
  syncRelForm();
  if (!F.a || !F.b) return toast("两个人都要选");
  if (F.a === F.b) return toast("不能给同一个人建关系");
  if (!F.kind) return toast("先选一个关系类型");
  if (writing) return;
  writing = true;
  const p = orderedPair();
  const old = F.relId;
  busy(true, "写入中…");
  try {
    const res = await api("/api/relations", {
      a_id: p[0], b_id: p[1], kind: F.kind, strength: F.strength,
      notes: F.notes, circle_id: S.circle.id,
    });
    /* 换类型:**先建后删**。反过来的话中途失败就一条都不剩了;
       这个顺序最坏也只是留下两条,看得见也删得掉。
       比 id 而不是比 kind:在「换类型」里又选回原来那个类型时,
       upsert 命中的就是老那条,这时候再去删就把它删没了。 */
    if (F.mode === "swap" && old && res.id !== old) {
      await api("/api/relations/delete", { id: old });
    }
    await syncPairEdge(F.a, F.b);
    busy(false);
    await refresh();
    if (!S.graphLoaded) await loadGraph();
    toast(F.mode === "swap" ? `已换成「${F.kind}」` : "已记下");
    showPair(F.a, F.b);
  } catch (e) { busy(false); toast(humanError(e, "保存关系失败")); }
  finally { writing = false; }
}

/* 连线卡上的三个按钮。传下标而不是把 kind / notes 拼进 onclick,
   备注里一个引号就能把属性拆掉。 */
function editRelation(i) {
  const r = S.pair.relations[i];
  openRelForm({ mode: "edit", a: r.a_id, b: r.b_id, kind: r.kind,
                relId: r.id, strength: r.strength, notes: r.notes || "" });
}

function swapRelation(i) {
  const r = S.pair.relations[i];
  openRelForm({ mode: "swap", a: r.a_id, b: r.b_id, kind: "", oldKind: r.kind,
                relId: r.id, strength: r.strength, notes: r.notes || "" });
}

async function delRelation(i) {
  const r = S.pair.relations[i];
  const a = S.pair.a.id, b = S.pair.b.id;
  if (writing) return;
  writing = true;
  busy(true, "删除中…");
  try {
    await api("/api/relations/delete", { id: r.id });
    await syncPairEdge(a, b);
    busy(false);
    await refresh();
    if (!S.graphLoaded) await loadGraph();
    // 撤销是照原样重建一条(id 会变,内容一模一样)
    toastUndo(`已删除「${r.kind}」`, () => undoDelRelation(r, a, b));
    showPair(a, b);
  } catch (e) { busy(false); toast(humanError(e, "删除失败")); }
  finally { writing = false; }
}

async function undoDelRelation(r, a, b) {
  if (writing) return;
  writing = true;
  busy(true, "撤销中…");
  try {
    await api("/api/relations", {
      a_id: r.a_id, b_id: r.b_id, kind: r.kind, strength: r.strength,
      notes: r.notes || "", circle_id: r.circle_id,
    });
    await syncPairEdge(a, b);
    busy(false);
    await refresh();
    if (!S.graphLoaded) await loadGraph();
    toast("已恢复");
    showPair(a, b);
  } catch (e) { busy(false); toast(humanError(e, "撤销失败")); }
  finally { writing = false; }
}

/* ---------------- 记一笔(事件) ---------------- */

function openEventForm(ids) {
  F.people = (ids || []).slice();
  F.text = "";
  F.open = null;
  F.q = "";
  renderEventForm();
}

function renderEventForm() {
  formKind = "evt";
  const chips = F.people.map(id => {
    const p = personById(id);
    return `<span class="tag blurable" data-drop="${id}">${
      esc(p ? p.name : "#" + id)} ✕</span>`;
  }).join("") || '<span class="dimtext">还没选人。只写一段话也能存,' +
                 '但挂上人之后才会出现在他们的卡片里。</span>';

  openSheet(`
    <h3>记一笔</h3>
    <div class="sub">记到「${esc(S.circle.name)}」。不经过 AI,只走本机。</div>
    <label>发生了什么</label>
    <textarea id="evtText" class="compact"
      placeholder="例:年会上他俩为了同一个项目当众吵了一架。">${esc(F.text)}</textarea>
    <label>牵涉到谁</label>
    <div class="hstack wrap">${chips}</div>
    ${pickerHtml("e", "加一个人", null)}
    <div class="btn-row">
      <button class="btn primary" id="evtSave">保存</button>
      <button class="btn" onclick="closeSheets()">取消</button>
    </div>`, "记一笔");

  bindPicker("e", id => {
    F.text = ($("#evtText") || {}).value || F.text;
    if (!F.people.includes(id)) F.people.push(id);
    F.q = "";
    renderEventForm();          // 面板保持展开,可以接着挑下一个
  });
  $("#sheetBody").querySelectorAll("[data-drop]").forEach(el => {
    el.onclick = () => {
      F.text = $("#evtText").value;
      F.people = F.people.filter(x => x !== +el.dataset.drop);
      renderEventForm();
    };
  });
  $("#evtSave").onclick = saveEvent;
}

async function saveEvent() {
  const text = $("#evtText").value.trim();
  if (!text) return toast("先写点内容");
  if (writing) return;
  writing = true;
  busy(true, "写入中…");
  try {
    await api("/api/events", {
      text, people: F.people, circle_id: S.circle.id, source: "手动",
    });
    busy(false);
    closeSheets();
    toast("记下了");
    // 事件不改变图的结构(不加人也不加边),所以这里**不重排、不重取图**
  } catch (e) { busy(false); toast(humanError(e, "保存失败")); }
  finally { writing = false; }
}

/* AI 输入栏里的 ＋。不做悬浮 FAB:右下角被送出键占着,左下角是图例。 */
function openAddMenu() {
  openSheet(`
    <h3>手动录一笔</h3>
    <div class="sub">不经过 AI,全程只走本机 —— 一个字都不会外发。</div>
    <div class="list">
      <div class="row" onclick="newPersonForm()">
        <svg class="ic" aria-hidden="true"><use href="#i-person"/></svg>
        <div class="main"><div class="nm">新建人物</div>
          <div class="meta">加进「${esc(S.circle.name)}」</div></div>
        <span class="dimtext">›</span>
      </div>
      <div class="row" onclick="openRelForm({})">
        <svg class="ic" aria-hidden="true"><use href="#i-graph"/></svg>
        <div class="main"><div class="nm">记一条关系</div>
          <div class="meta">选两个人 → 选类型 → 存</div></div>
        <span class="dimtext">›</span>
      </div>
      <div class="row" onclick="openEventForm()">
        <svg class="ic" aria-hidden="true"><use href="#i-plus"/></svg>
        <div class="main"><div class="nm">记一笔事情</div>
          <div class="meta">一段话,挂在几个人身上</div></div>
        <span class="dimtext">›</span>
      </div>
    </div>`, "手动录入");
}

async function markMe(pid) {
  await api("/api/people/me", { id: pid });
  await refresh();
  S.graphLoaded = false;
  loadGraph();
  toast("已设为「我」");
}

async function delPerson(pid) {
  if (!confirm("彻底删除这个人?他在所有圈子里的关系都会一起消失。")) return;
  await api("/api/people/delete", { id: pid });
  closeSheets();
  S.graphLoaded = false;
  await refresh();
  loadGraph();
  toast("已删除");
}

/* ---------------- 底部 AI 输入栏 ---------------- */

function bindAiBar() {
  const ta = $("#aiInput");
  ta.addEventListener("input", () => {
    ta.style.height = "auto";
    ta.style.height = Math.min(104, ta.scrollHeight) + "px";
  });
  $("#aiSend").onclick = sendIngest;
  // ＋ 挤在附件键左边,**送出键的位置一点不动** —— 那是肌肉记忆
  $("#aiPlus").onclick = openAddMenu;
  $("#aiAttach").onclick = () => $("#aiFile").click();
  $("#aiFile").onchange = guard(async e => {
    for (const f of e.target.files) {
      if (f.size > 12 * 1024 * 1024) { toast(`${f.name} 超过 12MB,太大了`); continue; }
      const data = await new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(",")[1] || "");
        fr.readAsDataURL(f);
      });
      S.files.push({ name: f.name, mime: f.type || "", data,
                     isImg: (f.type || "").startsWith("image/") });
    }
    e.target.value = "";
    paintFiles();
  }, "读取文件失败");
  paintFiles();
}

function paintFiles() {
  const box = $("#aiFiles");
  if (!S.files.length) return box.classList.add("hidden");
  box.classList.remove("hidden");
  box.innerHTML = S.files.map((f, i) => `
    <span class="filechip">
      ${f.isImg ? `<img src="data:${esc(f.mime)};base64,${f.data}" alt="">`
                : "📄"}
      ${esc(f.name.length > 14 ? f.name.slice(0, 13) + "…" : f.name)}
      <span class="x" data-i="${i}">✕</span>
    </span>`).join("");
  box.querySelectorAll(".x").forEach(x => {
    x.onclick = () => { S.files.splice(+x.dataset.i, 1); paintFiles(); };
  });
}

async function sendIngest() {
  const text = $("#aiInput").value.trim();
  if (!text && !S.files.length) return toast("先说点什么,或者上传一张截图");
  if (!S.state.llm_configured) {
    return showIngestUnconfigured();
  }
  busy(true, "AI 正在读…");
  try {
    const d = await api("/api/ingest", {
      text, files: S.files, circle_id: S.circle.id,
    });
    busy(false);
    showReview(d);
  } catch (e) {
    busy(false);
    toast(e.message);
  }
}

function showIngestUnconfigured() {
  openSheet(`
    <h3>AI 录入还没启用</h3>
    <div class="warnbox">
      需要先配置模型的 API Key。在电脑上设置环境变量
      <span class="mono">OPENAI_API_KEY</span>,然后重启服务即可。
    </div>
    <div class="hint">启用后可以:粘一段话、或直接丢一张聊天截图进来,
      AI 会把里面的人物和关系抽成候选清单,<b>每条都附上原文摘录</b>,
      你逐条确认后才入库。其余功能不受影响,现在就能用。</div>`);
}

function showReview(d) {
  const kinds = Object.keys(S.state.kinds);
  /* 以前这里是 filter(p => p.action !== "update"),把精确命中的人整个滤掉了 ——
     后果是模型从材料里读到的「李明远升了总监」这类**已有人员的字段更新**
     永远进不了库。现在全部列出,精确命中的默认不勾(避免拿模型的猜测
     覆盖你手填的部门职位),想更新就自己勾上。 */
  const people = d.persons;

  const pRows = people.map((p, i) => {
    const fuzzy = p.match_type === "fuzzy";
    const exact = p.match_type === "exact";
    // 模糊命中必须由人来定夺:合并进已有的人,还是真的是另一个人。
    // 默认选「合并」,但整行不预先勾选 —— 强迫看一眼再决定。
    const choice = fuzzy ? `
      <div class="hstack wrap" style="margin-top:6px">
        <label class="hstack tight">
          <input type="radio" name="pm${i}" class="pmerge" data-i="${i}"
                 value="merge" checked>
          <span class="blurable">合并进「${esc(p.matched_name)}」</span></label>
        <label class="hstack tight">
          <input type="radio" name="pm${i}" class="pmerge" data-i="${i}"
                 value="create">
          <span>是另一个人,新建</span></label>
      </div>` : "";
    return `
    <div class="row" style="align-items:flex-start">
      <input type="checkbox" class="pchk" data-i="${i}"
             ${fuzzy || exact ? "" : "checked"} style="margin-top:3px">
      <div class="main">
        <div class="nm blurable">${esc(p.name)}
          ${fuzzy ? `<span class="tag warn">名字很像:${esc(p.matched_name)}</span>`
            : exact ? `<span class="tag">库里已有</span>`
            : '<span class="tag">新建</span>'}</div>
        <div class="meta blurable">${esc(p.dept || "")} ${esc(p.title || "")}</div>
        ${choice}
      </div>
    </div>`;
  }).join("");

  const rRows = d.relations.map((r, i) => `
    <div class="card">
      <div class="hstack top">
        <input type="checkbox" class="rchk" data-i="${i}" checked style="margin-top:3px">
        <div class="grow">
          <div class="blurable"><b>${esc(r.a_name)}</b>
            <span class="dimtext">—</span> <b>${esc(r.b_name)}</b></div>
          <div class="hstack wrap" style="margin-top:var(--sp-15)">
            <select class="rkind sel-compact kind" data-i="${i}">
              ${kinds.map(k => `<option ${k === r.kind ? "selected" : ""}>${esc(k)}</option>`).join("")}
            </select>
            <select class="rstr sel-compact str" data-i="${i}">
              ${[3, 2, 1, 0, -1, -2, -3].map(v =>
                `<option value="${v}" ${v === r.strength ? "selected" : ""}>${
                  v > 0 ? "+" : ""}${v} ${STRENGTH_LABEL[v]}</option>`).join("")}
            </select>
          </div>
          <div class="evidence blurable">${esc(r.evidence)
            || "(模型没给出处 —— 建议取消勾选)"}</div>
          <div class="meta dimtext">把握 ${Math.round(r.confidence * 100)}%
            ${!r.a_id || !r.b_id ? " · 含新人物" : ""}</div>
        </div>
      </div>
    </div>`).join("");

  openSheet(`
    <h3>AI 读出来这些</h3>
    <div class="sub">用的是 ${esc(d.model)}。<b>每条都附了原文摘录</b>,
      扫一眼就知道它有没有编。确认无误的才会入库到「${esc(S.circle.name)}」。</div>

    <div class="sec">人物(${people.length})</div>
    <div class="list">${pRows || '<div class="dimtext">没有新人物</div>'}</div>

    <div class="sec">关系(${d.relations.length})</div>
    ${rRows || '<div class="dimtext">没抽到关系 —— 换个说法再试,或手动录入</div>'}

    <div class="btn-row">
      <button class="btn primary" id="reviewOk">确认入库</button>
      <button class="btn" onclick="closeSheets()">放弃</button>
    </div>`);

  $("#reviewOk").onclick = async () => {
    const persons = people.map((p, i) => {
      const merge = document.querySelector(`.pmerge[data-i="${i}"]:checked`);
      return {
        ...p,
        // 模糊行选了「合并」就走 matched_id,选「新建」则清掉它,
        // 否则 llm.commit 会把它当同一个人
        action: merge ? (merge.value === "merge" ? "merge" : "create") : p.action,
        matched_id: merge && merge.value === "create" ? null : p.matched_id,
        accepted: $(`.pchk[data-i="${i}"]`).checked,
      };
    });
    const relations = d.relations.map((r, i) => ({
      ...r,
      kind: $(`.rkind[data-i="${i}"]`).value,
      strength: +$(`.rstr[data-i="${i}"]`).value,
      accepted: $(`.rchk[data-i="${i}"]`).checked,
    }));
    busy(true, "写入中…");
    try {
      const res = await api("/api/ingest/commit", {
        ...d, persons, relations, circle_id: S.circle.id });
      busy(false);
      closeSheets();
      $("#aiInput").value = ""; $("#aiInput").style.height = "auto";
      S.files = []; paintFiles();
      S.graphLoaded = false;
      await refresh();
      loadGraph();
      toast(`入库:新建 ${res.people_created} 人 / ${res.relations} 条关系`);
    } catch (e) { busy(false); toast(e.message); }
  };
}

/* ---------------- 人物页 ---------------- */

/* 从任意列表跳到某个人:切回图谱、居中、开卡片。
   人物页本来就是这么干的,抽出来是因为局势页有四处要用(绕不开的人、
   跟我作对的人、派系名册、三角),而那串 setTimeout 拼在 onclick 里
   抄四遍迟早抄错一处 —— 而且只有点下去才看得出来。 */
function gotoPerson(pid) {
  switchView("graph");
  // 等一帧再定位:switchView 刚把 #view-graph 从 hidden 里放出来,
  // 这时候画布的 getBoundingClientRect 还是 0,centerOn 会算到屏幕外
  setTimeout(() => {
    showPerson(pid);
    GraphView.centerOn(pid, bottomInset() + 240);
  }, 60);
}

/* 人物页的列表**只建一次**,之后搜索只翻每一行的 hidden。

   以前是每敲一个键就把整块 innerHTML 重建一遍,而每一行都要走
   avatar() → GraphView.nodeColor() → data.nodes.find() 一次线性查找 ——
   合起来是 O(人数²);更难受的是重建会把滚动位置甩回顶部,
   往下翻着找人的时候打一个字就前功尽弃。

   什么时候才真的重建:S.people 换了对象(refresh() 每次都赋新数组),
   或者头像颜色的来源变了(图刚载入 / 派系着色开关翻了)。 */
let peopleBuilt = null;          // [上次建 DOM 用的那个数组, 当时的着色签名]

function renderPeople() {
  const box = $("#peopleList");
  if (!box) return;
  const sig = `${S.graphLoaded ? 1 : 0}${S.byFaction ? 1 : 0}`;
  if (!peopleBuilt || peopleBuilt[0] !== S.people || peopleBuilt[1] !== sig) {
    buildPeopleList(box);
    peopleBuilt = [S.people, sig];
  }
  filterPeople(box);
}

function buildPeopleList(box) {
  // 搜索键预存进 data-q:过滤时就是一次字符串 includes,不再逐行现拼现小写
  box.innerHTML = S.people.map(p => `
    <div class="row" data-pid="${p.id}" data-q="${esc(searchKey(p))}">
      ${avatar(p.id, p.name, "sm")}
      <div class="main">
        <div class="nm blurable">${esc(p.name)}${
          p.is_me ? ' <span class="tag">我</span>' : ""}</div>
        <div class="meta blurable">${esc(p.dept || "—")} ${esc(p.title || "")}</div>
      </div><span class="dimtext">›</span>
    </div>`).join("") +
    '<div class="dimtext empty-line" id="peopleNone" hidden></div>';
}

function filterPeople(box) {
  const q = ($("#peopleSearch").value || "").trim().toLowerCase();
  let shown = 0;
  for (const row of box.children) {
    if (!row.dataset.q) continue;             // 空态那一行不参与过滤
    const hit = !q || row.dataset.q.includes(q);
    row.hidden = !hit;
    if (hit) shown++;
  }
  const none = $("#peopleNone");
  if (!none) return;
  none.textContent = S.people.length ? "没有匹配的人" : "这个圈子里还没有人";
  none.hidden = shown > 0;
}

/* ============================================================
   诚实呈现:排第一名不等于「第一人选」
   ============================================================

   有两处在拿排序冒充结论:局势页的「主要矛盾」和人物卡的「可以拉拢谁」。
   拉拢分只有 conflict / reach / clout 几项,19 个人的圈子里 40 和 41 遍地都是;
   把 41 印成「1」、40 印成「2」,用户会照着这个顺序去行动 ——
   而那个顺序其实是 sort 的稳定性给的,不是数据给的。

   规则:top1 与 top2 差不到 LEAD_GAP 就不排名次,改说「没有压倒性的一个」。
   share(占全圈敌意的百分比)和 score(拉拢分)都已经归一到 0~100,
   所以同一个阈值对两处都成立 —— 这也是把它写成一个函数而不是两个的理由。 */
const LEAD_GAP = 10;

/* 领先集团有多大。rows 必须是已按 of() 降序排好的(服务端两处都排了全序)。
   返回 1 = 有一个明显的头名;>1 = 前几名咬在一起,谁第一取决于一两条关系。 */
function leadCount(rows, of) {
  if (!rows || !rows.length) return 0;
  const top = of(rows[0]);
  return rows.filter(r => top - of(r) < LEAD_GAP).length;
}

/* 拉拢分是个无量纲数,单甩一个 77.44 没人知道是高是低。分档词打头,
   分数缩成注脚 —— 它只用来在同一档里互相比较。
   表按阈值降序排,allyTier 靠这个顺序短路;顺序错了会静默返回错档,
   所以 fittest 里把「降序」本身也断言了。 */
const ALLY_TIERS = [[55, "首选"], [32, "可以争取"], [15, "得先铺路"],
                    [0, "基本指望不上"]];

function allyTier(score) {
  for (const [min, word] of ALLY_TIERS) if (score >= min) return word;
  return ALLY_TIERS[ALLY_TIERS.length - 1][1];
}

/* 「可以拉拢谁」的列表。approach 里带着真名(「可以托 林子豪 引荐」),
   所以那一行也必须 blurable —— 这是最容易漏掉的一处。 */
function allyRows(cands) {
  if (!cands || !cands.length)
    return '<div class="dimtext empty-line">没找到跟他有矛盾的人</div>';
  const lead = leadCount(cands, c => c.score);
  const note = lead > 1 ? `<div class="warnbox">前 ${lead} 个人分数咬得很紧
      (相差不到 ${LEAD_GAP} 分),<b>没有明显的第一人选</b> ——
      挑你自己更说得上话的那个,别照着名次来。</div>` : "";
  return note + '<div class="list">' + cands.map((c, i) => `
    <div class="row">
      <div class="num dimtext rank">${lead > 1 ? "·" : i + 1}</div>
      <div class="main">
        <div class="nm blurable">${esc(c.name)}</div>
        <div class="meta">矛盾:${c.conflict_kinds.map(esc).join("、")}(烈度 ${c.conflict})</div>
        <div class="meta blurable">${esc(c.approach)}</div>
      </div>
      <div class="tier">${esc(allyTier(c.score))}<em>${Math.round(c.score)}</em></div>
    </div>`).join("") + "</div>";
}


/* ============================================================
   局势页
   ============================================================

   顺序是「我 → 矛盾 → 人 → 下手处」。用户是局中人不是观察者:
   is_me 以前只被 intro_path 当起点用过,全 app 没有一个以我为中心的视图,
   而这一页要回答的第一个问题就是「我现在站在哪」。

   数据一次 GET /api/analysis/situation 取回,**绝不搭 /api/graph 的车** ——
   后者是全项目最慢的接口(冷启动 2.1 秒),而且每次 resize、每次切圈子
   都会重发;把一个你可能从不打开的页面的数据塞进去,是让最慢的更慢。

   这一页直接写着「谁跟我作对」,是全 app 最不能被人瞥见的一页 ——
   **每一个人名、派系名都必须带 class="blurable"**,顶栏的打码开关靠它。 */

/* 内存缓存。键 = graph_version + 圈子 id。graph_version 是 /api/state 早就
   返回、前端一次没用过的字段;任何写操作都会 bump 它,所以这里不需要自己
   判断「什么时候该失效」。版本一变旧条目再也不可能命中,顺手清掉。 */
const sitCache = new Map();

function sitKey() {
  return `${S.state ? S.state.graph_version : 0}:${S.circle ? S.circle.id : ""}`;
}

/* 串行闸。/api/analysis/situation 是个**会写库的 GET** —— 没命中缓存时
   db.cache_put 要写一条。而 db 是全进程一个 sqlite 连接、tx() 直接在共享
   连接上 commit(),服务是 ThreadingHTTPServer:两个请求并发进来,一个线程的
   commit() 会把另一个线程写了一半的事务一起提交。写操作那边(saveRelation 等)
   用的是同一套办法,这里不能开例外。 */
let sitBusy = false;

async function renderSituation() {
  const box = $("#situationBody");
  const key = sitKey();
  // 屏幕上已经是这份数据了就一个字都别动:重设 innerHTML 会把派系名册的
  // 展开状态和整页滚动位置一起清掉,而切出去看个人再切回来是常见动作
  if (box.dataset.key === key) return;
  const hit = sitCache.get(key);
  if (hit) { paintSituation(box, key, hit); return; }
  if (sitBusy) return;          // 落地时会自己再看一眼键,这一次不会被丢掉
  sitBusy = true;

  box.dataset.key = "";
  box.innerHTML = '<div class="dimtext empty-line">正在算这个圈子的局势…</div>';
  try {
    // cq() 在这里是同步取的,和上面那行 sitKey() 之间没有 await,
    // 所以请求发出去的圈子和 key 里记的圈子一定是同一个
    const d = await api("/api/analysis/situation?" + cq());
    const ver = key.split(":")[0];
    for (const k of [...sitCache.keys()])
      if (!k.startsWith(ver + ":")) sitCache.delete(k);
    sitCache.set(key, d);
    // 慢请求回来时用户可能已经切走或换了圈子 —— 那就别再往 DOM 上写,
    // 否则「公司圈」的局势会印在「同学圈」的页面上
    if (S.view !== "situation" || sitKey() !== key) return;
    paintSituation(box, key, d);
  } catch (e) {
    box.innerHTML = `<div class="warnbox">${esc(humanError(e, "算不出局势"))}</div>`;
  } finally {
    sitBusy = false;
    // 请求在飞的时候换了圈子 → 现在把那一次补上(键没变就什么都不做,
    // 所以不会自己叫自己叫下去)
    if (S.view === "situation" && sitKey() !== key) renderSituation();
  }
}

function paintSituation(box, key, d) {
  box.innerHTML = situationHtml(d);
  box.dataset.key = key;
}

/* 纯函数:数据 → HTML。渲染不碰 DOM、不发请求,所以 fittest 能整页跑一遍,
   逐个人名核对打码、核对五块的先后顺序。 */
function situationHtml(d) {
  return meSection(d) +
         tensionSection(d.tensions || []) +
         keySection(d.key_people || []) +
         triSection(d.triangles || []) +
         factionSection(d.factions || []);
}

/* 「3 组人正面对上 · 最深的一处 -3 势不两立 · 占全圈敌意 43%」
   —— 我的处境和主要矛盾两处共用这一句。
   服务端的 hostility 是一堆负强度加起来的裸数,印出来等于没印:
   「7」是多是少?几个人在掐?所以这里一个字都不提它。
   worst 是正数(最深那条边的 -w),所以取文案要再取一次负号。 */
function frontDetail(t) {
  return `${t.fronts} 组人正面对上 · 最深的一处 ${strengthText(-t.worst)} ·
    占全圈敌意 ${t.share}%`;
}

function frontPairs(pairs) {
  return (pairs || []).slice(0, 4).map(p =>
    `<span class="tag neg blurable">${esc(p.a_name)} ↔ ${esc(p.b_name)} ${p.w}</span>`
  ).join("");
}

/* ---- ① 我的处境 ---- */

function meSection(d) {
  const head = '<div class="sec">我的处境</div>';
  const me = d.me;
  if (!me) return head + meCta(d.me_missing);

  const f = me.faction;
  const facLine = f
    ? `<div>你在 <b class="blurable">${esc(f.label)}</b>(${f.size} 人)里,` +
      (f.is_core ? "而且你就是这一派的核心。"
                 : `核心是 <b class="blurable">${esc(f.core || "—")}</b>。`) + "</div>"
    : "<div>你还没被归进任何一派 —— 说明记录到的正向关系太少,先补几条。</div>";

  const fr = me.front;
  const frontLine = fr
    ? `<div class="hint">这一派正跟 <b class="blurable">${esc(fr.label)}</b>` +
      `(${fr.size} 人)对着 —— ${frontDetail(fr)}。</div>` +
      `<div class="hint">${frontPairs(fr.pairs)}</div>`
    : '<div class="hint">你这一派目前没有跟谁正面对上。</div>';

  const rivals = me.rivals || [];
  const rivalBox = rivals.length
    ? `<div class="hint">跟你直接结怨的 ${rivals.length} 个人
         (库里真有负向关系,不是推断出来的):</div>
       <div class="list">${rivals.map(r => `
         <div class="row" onclick="gotoPerson(${r.id})">
           ${avatar(r.id, r.name, "sm")}
           <div class="main">
             <div class="nm blurable">${esc(r.name)}</div>
             <div class="meta blurable">${esc(r.dept || "—")}</div>
           </div>${strengthTag(r.w)}
         </div>`).join("")}</div>`
    : '<div class="hint">目前没有人跟你直接结怨。</div>';

  return head +
    `<div class="list"><div class="row" onclick="gotoPerson(${me.id})">
       ${avatar(me.id, me.name)}
       <div class="main">
         <div class="nm blurable">${esc(me.name)} <span class="tag">我</span></div>
         <div class="meta blurable">${esc(me.dept || "—")}</div>
       </div>
       <div class="tier">第 ${me.rank} / ${me.total}<em>绕不开程度</em></div>
     </div></div>` +
    `<div class="card">${facLine}${frontLine}</div>` +
    rivalBox;
}

/* 没设「我是谁」时整块换成跳设置页的 CTA。静默降级成一块空白比什么都不显示
   更糟 —— 用户分不清是没数据还是坏了。showPerson 的引荐路径就是这么处理的。 */
function meCta(missing) {
  const outside = missing === "outside";
  const cname = S.circle ? S.circle.name : "这个圈子";
  return `<div class="card">
      <div>${outside
        ? `你设的「我」不在 <b>「${esc(cname)}」</b> 里。`
        : "还没告诉这个应用 <b>你是谁</b>。"}</div>
      <div class="hint">${outside
        ? "先把自己加进这个圈子,或者切到你在的那个圈子 —— 否则这一页只能给你一张旁观者的表。"
        : "这一页每句话都是相对你说的:你在哪一派、谁在跟你作对、你有多绕不开。缺了这个起点,剩下的都只是别人的事。"}</div>
      <div class="btn-row">
        <button class="btn primary" onclick="switchView('settings')">
          去设置页指定「我是谁」</button>
      </div>
    </div>`;
}

/* ---- ② 主要矛盾 ---- */

function tensionSection(ts) {
  const head = '<div class="sec">主要矛盾</div>';
  if (!ts.length)
    return head + `<div class="card"><div class="dimtext">
      这个圈子里还没有记录到跨派系的敌意 —— 要么真的太平,要么负向关系还没录进来。
      </div></div>`;
  return head + `<div class="card">${tensionHeadline(ts)}</div>` +
    ts.slice(0, 3).map(t => `<div class="card">${formatTension(t)}</div>`).join("");
}

/* 只有 top1 与 top2 的 share 差 ≥ LEAD_GAP 才配叫「主要矛盾」。
   差得不够就明说「势均力敌」—— 这一页的全部价值就在于它说的是真的。 */
function tensionHeadline(ts) {
  if (!ts.length) return "";
  const n = leadCount(ts, t => t.share);
  const t = ts[0];
  if (n > 1)
    return `<b>有 ${n} 组势均力敌的矛盾,目前没有压倒性的一个。</b>
      <div class="hint">前 ${n} 组占全圈敌意的比例互相差不到 ${LEAD_GAP} 个百分点,
        谁排第一取决于一两条关系的强度 —— 别把这个顺序当结论。</div>`;
  const gap = ts.length > 1 ? (t.share - ts[1].share).toFixed(1) : null;
  return `<b>主要矛盾:<span class="blurable">${esc(t.a_label)}</span> 对
      <span class="blurable">${esc(t.b_label)}</span>。</b>
    <div class="hint">${gap === null
      ? "全圈就这一组跨派系的矛盾。"
      : `它占了全圈敌意的 ${t.share}%,比第二组高 ${gap} 个百分点 —— 拉得够开,可以当主线看。`
    }</div>`;
}

function formatTension(t) {
  return `<div class="hstack wrap">
      <b class="blurable">${esc(t.a_label)}</b>
      <span class="dimtext">↔</span>
      <b class="blurable">${esc(t.b_label)}</b>
      <span class="tag neg">${t.share}%</span>
    </div>
    <div class="hint">${t.a_size} 人 对 ${t.b_size} 人 · ${frontDetail(t)}</div>
    <div class="hint">${frontPairs(t.pairs)}</div>`;
}

/* ---- ③ 绕不开的人 ---- */

function keySection(ppl) {
  const head = `<div class="sec">绕不开的人</div>
    <div class="hint">有多少条最短联络路径必须经过他(相对第一名的百分比)。
      这些人拦下一句话,消息就到不了另一头。</div>`;
  if (!ppl.length)
    return head + '<div class="dimtext empty-line">这个圈子里还没有人</div>';
  return head + '<div class="list">' + ppl.slice(0, 8).map((p, i) => `
    <div class="row" onclick="gotoPerson(${p.id})">
      <div class="num dimtext rank">${i + 1}</div>
      ${avatar(p.id, p.name, "sm")}
      <div class="main">
        <div class="nm blurable">${esc(p.name)}</div>
        <div class="meta blurable">${esc(p.dept || "—")}</div>
      </div>
      <div class="tier">${p.betweenness_pct}%<em>朋友 ${p.friends} · 结怨 ${p.enemies}</em></div>
    </div>`).join("") + "</div>";
}

/* ---- ④ 最容易撬动的地方 ---- */

function triSection(tris) {
  const head = `<div class="sec">最容易撬动的地方</div>
    <div class="hint">两正一负、或者三条全负的三角在结构上是不稳的,
      局势最可能从这里翻。按撬动价值排序 —— 那个数本身没有量纲,不印出来。</div>`;
  if (!tris.length)
    return head + '<div class="dimtext empty-line">目前没有不稳定的三角</div>';
  // hint 字段本来就是人话(「最省力的撬点:X 与 Y 的矛盾…」),直接印,
  // 但它带着真名,所以整行都要 blurable
  return head + tris.slice(0, 5).map(t => `
    <div class="card">
      <div class="hstack wrap">
        <b class="blurable">${t.members.map(m => esc(m.name)).join(" — ")}</b>
        <span class="tag">${esc(t.pattern)}</span>
      </div>
      <div class="hint blurable">${esc(t.hint)}</div>
    </div>`).join("");
}

/* ---- ⑤ 派系名册(默认折叠) ---- */

function factionSection(fs) {
  if (!fs.length) return "";
  const total = fs.reduce((s, f) => s + f.size, 0);
  // <details> 自带展开逻辑,零 JS。默认折叠:名册是「想查的时候才查」的东西,
  // 摊开会把前面四块真正要看的内容顶出屏幕。
  /* 名册里的名字只是名字,不挂点击:.tag 高 20px,做成热区就违反了
     「可点元素至少 44px」那条,而这里本来也只是给人扫一眼的。 */
  return `<div class="sec">派系名册</div>
    <details class="fold">
      <summary>${fs.length} 个派系 · ${total} 人</summary>
      ${fs.map(f => `<div class="card">
        <div class="hstack wrap">
          <b class="blurable">${esc(f.label)}</b>
          <span class="tag">${f.size} 人</span>
          ${f.core ? `<span class="tag">核心 <span class="blurable">${
            esc(f.core.name)}</span></span>` : ""}
        </div>
        <div class="hint">${f.members.map(m =>
          `<span class="tag blurable">${esc(m.name)}</span>`).join("")}</div>
        ${f.straddlers && f.straddlers.length ? `<div class="hint">骑墙的:${
          f.straddlers.map(m => `<span class="tag blurable">${esc(m.name)}</span>`).join("")
          } —— 对外的正向关系占了四成以上,两边都说得上话。</div>` : ""}
      </div>`).join("")}
    </details>`;
}


/* ---------------- 设置页 ---------------- */

function renderSettings() {
  const st = S.state;
  const meOpts = S.people.map(p =>
    `<option value="${p.id}" ${st.me && st.me.id === p.id ? "selected" : ""}>${
      esc(p.name)}</option>`).join("");

  $("#settingsBody").innerHTML = `
    <div class="sec">圈子</div>
    ${st.circles.map(c => `
      <div class="row">
        <span class="glyph">${esc(c.icon || "🌐")}</span>
        <div class="main">
          <div class="nm">${esc(c.name)}</div>
          <div class="meta">${esc(c.kind)} · ${c.people} 人 · ${c.relations} 条关系</div>
        </div>
        <button class="btn mini"
          onclick="renameCircle(${c.id})">改名</button>
        <button class="btn danger mini"
          onclick="dropCircle(${c.id})">删</button>
      </div>`).join("")}
    <div class="btn-row"><button class="btn" onclick="newCircle()">＋ 新建圈子</button></div>

    <div class="sec">我是谁</div>
    <div class="card">
      <div class="hint" style="margin:0 0 8px">
        「可以拉拢谁」和「我该托谁引荐」都要以你为起点,必须先指定。</div>
      <select id="meSel"><option value="">— 未设置 —</option>${meOpts}</select>
    </div>

    <div class="sec">往「${esc(S.circle.name)}」里批量导入</div>
    <div class="card">
      <label>人员名单(每行一人:姓名,部门,职位)</label>
      <textarea id="rosterText" class="compact"
        placeholder="张三,技术部,后端工程师&#10;李四,市场部,销售经理"></textarea>
      <div class="btn-row"><button class="btn" id="rosterGo">预览并导入</button></div>
      <div id="rosterOut"></div>
    </div>
    <div class="card">
      <label>关系(每行一条:人名-人名:关系 强度)</label>
      <textarea id="bulkText" class="compact"
        placeholder="张三-李四:情敌3&#10;张三 -> 王五 : 提携 2"></textarea>
      <label class="hstack">
        <input type="checkbox" id="bulkAuto"> 遇到库里没有的人,自动建
      </label>
      <div class="btn-row"><button class="btn" id="bulkGo">预览并导入</button></div>
      <div id="bulkOut"></div>
      <div class="hint">可用关系:${
        st.categories.map(c => `<b>${esc(c)}</b>:` +
          Object.keys(st.kinds).filter(k => st.kinds[k].cat === c).map(esc).join("、")
        ).join("<br>")}</div>
    </div>

    <div class="sec">数据</div>
    <div class="card">
      <div class="hint">全库共 ${st.counts.people} 人 ·
        ${st.counts.relations} 条关系 · ${st.counts.events} 条事件</div>
      <div class="btn-row">
        <button class="btn" id="exportBtn">导出备份</button>
        <button class="btn" id="importBtn">导入备份</button>
      </div>
      <input type="file" id="importFile" accept=".json" class="hidden">
      <div class="btn-row"><button class="btn" id="seedBtn">载入演示数据</button></div>
      <div class="hint">演示数据是一个虚构的公司圈 + 同学圈,人名全是编的,
        可以用来试功能。</div>
    </div>

    <div class="sec">模型</div>
    <div class="card"><div class="hint">
      ${st.llm_configured
        ? `已启用 · <span class="mono">${esc(st.llm_model)}</span>`
        : '未配置。设置环境变量 <span class="mono">OPENAI_API_KEY</span> 后重启服务。'}
    </div></div>

    <div class="sec">外观</div>
    <div class="card">
      <label class="hstack">
        <input type="checkbox" id="facSw" ${S.byFaction ? "checked" : ""}>
        <span class="grow">按派系着色</span>
        <svg class="ic sm dimtext" aria-hidden="true"><use href="#i-palette"/></svg>
      </label>
      <div class="hint">
        关掉时画面是灰阶,颜色只出现在两个地方:「我」和<b
        style="color:var(--neg-ink)">负向关系</b> —— 让矛盾成为画面上唯一
        跳出来的东西。打开后用经过色觉障碍校验的分类色板给前三大派系上色。<br>
        深浅主题在顶栏切换。
      </div>
    </div>

    <div class="sec">隐私</div>
    <div class="card"><div class="hint">
      · 服务只监听本机和 Tailscale,公网扫不到<br>
      · 数据库只存在这台电脑上,<b>不会自动上传</b><br>
      · 顶栏的 🕶 一键把所有人名打码,防止手机被人瞥见<br>
      · <b>不要把 data 目录提交到任何公开仓库</b>
    </div>
    <div class="warnbox" style="margin-top:10px">
      <b>但用 AI 录入时,内容会离开这台电脑。</b><br>
      你输入的文字、上传的截图和文档,<b>以及当前圈子里全部人的姓名和部门</b>
      (为了让模型不把「张伟」认成新人,名单会随每次请求一起发出),
      都会发送给模型服务商。默认是 OpenAI。<br>
      不想外发就别用底部那个输入栏 —— 手工录入和批量导入全程只走本机。
      也可以把 <span class="mono">OPENAI_BASE_URL</span> 指向本地模型,
      这样连接口调用都不出这台机器。
    </div></div>`;

  $("#facSw").onchange = e => {
    S.byFaction = e.target.checked;
    localStorage.setItem("byFaction", S.byFaction ? "1" : "");
    GraphView.setFactionMode(S.byFaction);
    paintLegend();
  };

  $("#meSel").onchange = guard(async e => {
    if (!e.target.value) return;
    await api("/api/people/me", { id: +e.target.value });
    await refresh(); S.graphLoaded = false; toast("已设置");
  }, "设置「我是谁」失败");

  /* #rosterOut 这个容器一直存在,但从来没被填过 —— 按钮写着「预览并导入」,
     实际直接弹一个 confirm 报个数字,根本没有预览。现在真的先给出差异。 */
  $("#rosterGo").onclick = guard(async () => {
    const d = await api("/api/import/roster/preview", { text: $("#rosterText").value });
    if (!d.rows.length) return toast("没解析出内容");
    // importer.parse_roster 的状态只有三种:new / update / skip
    // (skip = 本次粘贴里重复出现,不是解析失败)
    const news = d.rows.filter(r => r.status === "new");
    const ups  = d.rows.filter(r => r.status === "update");
    const dup  = d.rows.filter(r => r.status === "skip");
    $("#rosterOut").innerHTML =
      `<div class="card"><div class="hint">` +
      `将<b>新建 ${news.length} 人</b>、<b>更新 ${ups.length} 人</b>` +
      (dup.length ? `,跳过 ${dup.length} 行重复` : "") + `。<br>` +
      (news.length ? `新建:${news.slice(0, 12).map(r => esc(r.name)).join("、")}` +
        (news.length > 12 ? ` 等 ${news.length} 人` : "") + `<br>` : "") +
      (ups.length ? `更新:${ups.slice(0, 12).map(r => esc(r.name)).join("、")}` +
        (ups.length > 12 ? ` 等 ${ups.length} 人` : "") : "") +
      `</div>` +
      (dup.length ? `<div class="warnbox" style="margin-top:8px">` +
        dup.map(r => `第 ${r.line} 行:${esc(r.message)}` +
          `<br><span class="mono dimtext">${esc(r.raw || "")}</span>`).join("<br>") +
        `</div>` : "") + `</div>`;
    const bad = dup;
    const n = news.length + ups.length;
    if (!n) return toast("没有可写入的行");
    if (!confirm(`将写入 ${n} 人到「${S.circle.name}」,继续?`)) return;
    const res = await api("/api/import/roster/commit",
      { rows: d.rows, circle_id: S.circle.id });
    // 只清成功的部分,解析失败的行留在框里等你改 —— 全清等于让人重打一遍
    keepFailedLines("#rosterText", bad);
    S.graphLoaded = false; await refresh(); renderSettings();
    toast(`新建 ${res.created} 人,更新 ${res.updated} 人`);
  }, "导入名单失败");

  $("#bulkGo").onclick = guard(async () => {
    const auto = $("#bulkAuto").checked;
    const d = await api("/api/import/relations/preview",
      { text: $("#bulkText").value, auto_create: auto });
    if (!d.rows.length) return toast("没解析出内容");
    const bad = d.rows.filter(r => r.status !== "ok");
    $("#bulkOut").innerHTML = bad.length
      ? `<div class="warnbox">${bad.length} 行有问题:<br>` +
        bad.slice(0, 5).map(r => `第 ${r.line} 行:${esc(r.message)}`).join("<br>") +
        "</div>" : "";
    const good = d.rows.length - bad.length;
    if (!good) return toast("没有可写入的行");
    if (!confirm(`将写入 ${good} 条关系到「${S.circle.name}」,继续?`)) return;
    const res = await api("/api/import/relations/commit",
      { rows: d.rows, auto_create: auto, circle_id: S.circle.id });
    keepFailedLines("#bulkText", bad);
    S.graphLoaded = false; await refresh(); renderSettings();
    toast(`写入 ${res.relations} 条关系` +
      (res.created_people ? `,新建 ${res.created_people} 人` : ""));
  }, "导入关系失败");

  $("#exportBtn").onclick = guard(async () => {
    const d = await api("/api/export");
    delete d._saved_to;
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "relation-graph-backup.json";
    a.click();
    toast("已导出(电脑上也存了一份)");
  }, "导出失败");
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = guard(async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      const res = await api("/api/import", { payload, replace: false });
      S.graphLoaded = false; await refresh(); renderSettings();
      toast(`导入 ${res.people} 人 / ${res.relations} 条关系`);
    } catch (err) { toast("导入失败:" + err.message); }
  }, "恢复备份失败");
  $("#seedBtn").onclick = loadSeed;
}

async function renameCircle(cid) {
  const c = S.state.circles.find(x => x.id === cid);
  const name = prompt("改成什么名字?", c.name);
  if (!name || name === c.name) return;
  await api("/api/circles", { id: cid, name });
  await refresh(); paintCircleBtn(); renderSettings();
  toast("已改名");
}

async function dropCircle(cid) {
  const c = S.state.circles.find(x => x.id === cid);
  if (!confirm(`删除「${c.name}」?\n\n这个圈子里的 ${c.relations} 条关系会消失,` +
               `但人不会被删(他们可能还在别的圈子里)。`)) return;
  await api("/api/circles/delete", { id: cid });
  await refresh();
  S.circle = S.state.circles[0];
  localStorage.setItem("circle", S.circle ? S.circle.id : "");
  paintCircleBtn(); S.graphLoaded = false; renderSettings();
  toast("已删除");
}

async function loadSeed() {
  if (S.state.counts.people > 0 &&
      !confirm("库里已经有数据了。演示数据会合并进去(不会删除现有内容),继续?")) return;
  busy(true, "载入中…");
  try {
    const res = await api("/api/seed", { replace: false });
    await refresh();
    S.circle = S.state.circles[0];
    localStorage.setItem("circle", S.circle.id);
    paintCircleBtn();
    S.graphLoaded = false;
    busy(false);
    switchView("graph");
    loadGraph();
    toast(`已载入 ${res.circles} 个圈子 / ${res.people} 人`);
  } catch (e) { busy(false); toast(e.message); }
}

/* Service Worker —— 让"添加到主屏幕"后能全屏离线打开外壳 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

/* 同样是逃生路径:boot 挂了说明应用没起来,样式表未必可用,
   所以这里的内联样式也是有意的。 */
boot().catch(e => {
  document.body.innerHTML =
    `<div style="padding:30px;color:#e66767;font:15px system-ui">
       启动失败:${esc(e.message)}</div>`;
});
