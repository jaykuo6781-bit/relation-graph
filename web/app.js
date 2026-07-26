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

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2600);
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

function strengthTag(w) {
  const cls = w > 0 ? "pos" : (w < 0 ? "neg" : "");
  return `<span class="tag ${cls}">${w > 0 ? "+" : ""}${w} ${STRENGTH_LABEL[w] || ""}</span>`;
}

function avatar(id, name, size) {
  const s = size || 44;
  return `<div class="avatar blurable" style="background:${GraphView.nodeColor(id)};
    width:${s}px;height:${s}px;font-size:${Math.round(s * 0.4)}px">${esc((name || "?")[0])}</div>`;
}

/* ---------------- 主题 ---------------- */

// 默认深色 —— 关系图在深底上才成立(发光、景深、弱化背景都只在深色下有意义)
function applyTheme(t) {
  document.documentElement.setAttribute("data-theme", t);
  const meta = document.querySelector('meta[name="theme-color"]');
  // 必须和 --bg-0 一致,否则 iOS 状态栏和顶栏之间会有一条可见的色差缝
  if (meta) meta.setAttribute("content", t === "light" ? "#f4f6f8" : "#080c18");
  const b = $("#themeBtn");
  if (b) b.textContent = t === "light" ? "☾" : "☀";
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
  // 双击 index.html 打开时地址是 file:///…,浏览器不让页面读数据,
  // 样式和脚本也加载不到。与其让人对着一堆报错发愣,不如直接说清楚。
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
  // 视觉强度档位。对比页定稿后把默认值改成用户选的那一档。
  GraphView.setStyle(GraphStyles[localStorage.getItem("gstyle") || "B"]);
  GraphView.init({
    onNode: showPerson,
    onEdge: showPair,
    onBlank: closeSheets,
  });

  document.querySelectorAll(".navbtn").forEach(b => {
    b.onclick = () => switchView(b.dataset.view);
  });

  $("#maskBtn").onclick = () => {
    const on = document.body.classList.toggle("masked");
    $("#maskBtn").classList.toggle("on", on);
    localStorage.setItem("masked", on ? "1" : "");
  };
  if (localStorage.getItem("masked")) {
    document.body.classList.add("masked");
    $("#maskBtn").classList.add("on");
  }

  $("#circleBtn").onclick = toggleCircleMenu;
  document.addEventListener("click", e => {
    if (!e.target.closest("#circleBtn") && !e.target.closest("#circleMenu"))
      setCircleMenuOpen(false);
  });

  // 复位 = 把拖过的球放回算法排的位置(拖动本就不持久化)+ 重新贴合视口
  $("#fitBtn").onclick = () => {
    closeSheets();
    const restored = GraphView.resetPositions();
    GraphView.fit(bottomInset());
    if (restored) toast("已放回原来的位置");
  };
  $("#themeBtn").onclick = toggleTheme;
  $("#facBtn").onclick = () => {
    S.byFaction = !S.byFaction;
    localStorage.setItem("byFaction", S.byFaction ? "1" : "");
    GraphView.setFactionMode(S.byFaction);
    $("#facBtn").classList.toggle("on", S.byFaction);
    paintLegend();
    toast(S.byFaction ? "按派系着色" : "回到灰阶");
  };
  S.byFaction = !!localStorage.getItem("byFaction");
  $("#facBtn").classList.toggle("on", S.byFaction);

  // 窗口尺寸变了可能跨到另一个画布档位,重新取一次
  let rz;
  window.addEventListener("resize", () => {
    clearTimeout(rz);
    rz = setTimeout(() => {
      if (S.view === "graph") { S.graphLoaded = false; loadGraph(); }
    }, 350);
  });

  bindAiBar();
  watchAiBar();
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
  document.querySelectorAll(".navbtn").forEach(b =>
    b.classList.toggle("on", b.dataset.view === name));
  $("#aibar").classList.toggle("hidden", name !== "graph");
  $("#fitBtn").classList.toggle("hidden", name !== "graph");
  measureAiBar();          // 显隐变了,图例的落点要跟着变

  if (name === "graph" && !S.graphLoaded) loadGraph();
  if (name === "people") renderPeople();
  if (name === "settings") renderSettings();
}

/* ---------------- 圈子切换 ---------------- */

function paintCircleBtn() {
  const c = S.circle;
  $("#circleBtn").innerHTML =
    `<span class="ico">${esc(c ? c.icon || "🌐" : "🌐")}</span>` +
    `<span class="nm">${esc(c ? c.name : "全部")}</span>` +
    `<span class="caret">▾</span>`;
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
     <button class="cmenu-item" data-act="new"><span class="ico">＋</span>
       <span>新建圈子</span></button>
     <button class="cmenu-item" data-act="manage"><span class="ico">⚙</span>
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
    (S.byFaction ? `<span class="k">节点颜色 = 派系</span>`
                 : `<span class="k">节点亮度 = 重要程度</span>`);
}

function closeSheets() {
  document.querySelectorAll(".sheet").forEach(s => s.classList.add("hidden"));
  GraphView.focus(null);
}

/* ---------------- 人物卡片(四个分析折叠在这里) ---------------- */

async function showPerson(pid) {
  GraphView.focus(pid);
  const sheet = $("#sheet");
  sheet.innerHTML = '<div class="sheet-grab"></div><div class="dimtext">载入中…</div>';
  sheet.classList.remove("hidden");

  let d, b;
  try {
    [d, b] = await Promise.all([
      api(`/api/person?id=${pid}&` + cq()),
      api(`/api/analysis/brief?id=${pid}&` + cq()),
    ]);
  } catch (e) { sheet.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }

  const p = d.person;

  const rels = d.relations.map(r => {
    const otherId = r.a_id === pid ? r.b_id : r.a_id;
    const other = r.a_id === pid ? r.b_name : r.a_name;
    const dir = r.directed
      ? (r.a_id === pid ? " →" : " ←") : "";
    return `<div class="row" onclick="showPair(${pid},${otherId})">
      ${avatar(otherId, other, 30)}
      <div class="main">
        <div class="nm blurable">${esc(other)}</div>
        <div class="meta">${esc(r.glyph || "")} ${esc(r.kind)}${dir}${
          r.notes ? " · " + esc(r.notes) : ""}</div>
      </div>${strengthTag(r.strength)}</div>`;
  }).join("") || '<div class="dimtext">这个圈子里还没记录他的关系</div>';

  // ---- 敌人的敌人 ----
  const allies = (b.allies && b.allies.candidates || []).slice(0, 6);
  const alliesHtml = allies.length ? allies.map((c, i) => `
    <div class="row">
      <div class="num dimtext" style="width:18px">${i + 1}</div>
      <div class="main">
        <div class="nm blurable">${esc(c.name)}</div>
        <div class="meta">矛盾:${c.conflict_kinds.map(esc).join("、")}(烈度 ${c.conflict})</div>
        <div class="meta">${esc(c.approach)}</div>
      </div><div class="num">${c.score}</div>
    </div>`).join("")
    : '<div class="dimtext">没找到跟他有矛盾的人</div>';

  // ---- 引荐路径 ----
  const intro = b.intro && b.intro.path
    ? `<div class="card"><div class="blurable" style="font-size:15px">
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

  sheet.innerHTML = `
    <div class="sheet-grab"></div>
    <button class="close" onclick="closeSheets()">✕</button>
    <div class="head">
      ${avatar(pid, p.name)}
      <div style="flex:1;min-width:0">
        <h3 class="blurable">${esc(p.name)}${p.is_me ? ' <span class="tag">我</span>' : ""}</h3>
        <div class="sub" style="margin:0">${esc(p.dept || "")} ${esc(p.title || "")}</div>
      </div>
    </div>
    <div style="margin-bottom:10px">${d.circles.map(c =>
      `<span class="tag">${esc(c.icon || "")} ${esc(c.name)}</span>`).join("")}</div>

    <div class="sec">关系(${d.relations.length})</div>
    <div class="list">${rels}</div>

    <div class="sec">可以拉拢谁对付他</div>
    <div class="list">${alliesHtml}</div>

    <div class="sec">我该托谁引荐</div>${intro}

    ${fac ? '<div class="sec">他所在的派系</div>' + fac : ""}

    <div class="sec">他周围的不稳定三角</div>${tris}

    <div class="sec">相关事件(${d.events.length})</div>
    ${d.events.slice(0, 6).map(e => `<div class="card">
        <div class="blurable">${esc(e.text)}</div>
        <div class="hint">${new Date(e.happened_at * 1000).toLocaleDateString("zh-CN")}
          ${e.source ? " · " + esc(e.source) : ""}</div></div>`).join("")
      || '<div class="dimtext">还没有相关事件</div>'}

    <div class="btn-row">
      <button class="btn" onclick="markMe(${pid})">设为「我」</button>
      <button class="btn danger" onclick="delPerson(${pid})">删除此人</button>
    </div>`;
}

/* ---------------- 连线卡片:两个人之间的故事 ---------------- */

async function showPair(a, b) {
  GraphView.focusEdge(a, b);
  const sheet = $("#sheet");
  sheet.innerHTML = '<div class="sheet-grab"></div><div class="dimtext">载入中…</div>';
  sheet.classList.remove("hidden");

  let d;
  try {
    d = await api(`/api/pair?a=${a}&b=${b}&` + cq());
  } catch (e) { sheet.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; return; }

  const rels = d.relations.map(r => {
    const dir = r.directed
      ? `<div class="meta">方向:${esc(r.a_name)} → ${esc(r.b_name)}</div>` : "";
    return `<div class="card">
      <div style="display:flex;align-items:center;gap:8px">
        <span style="font-size:17px">${esc(r.glyph || "")}</span>
        <b>${esc(r.kind)}</b>${strengthTag(r.strength)}
        <span class="spacer"></span>
        <button class="btn" style="padding:5px 10px;font-size:13px"
          onclick="delRelation(${r.id},${a},${b})">删</button>
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

  sheet.innerHTML = `
    <div class="sheet-grab"></div>
    <button class="close" onclick="closeSheets()">✕</button>
    <div class="head">
      ${avatar(a, d.a.name, 38)}
      <span class="dimtext" style="font-size:18px">—</span>
      ${avatar(b, d.b.name, 38)}
      <div style="flex:1;min-width:0">
        <h3 class="blurable" style="font-size:17px">${esc(d.a.name)} 与 ${esc(d.b.name)}</h3>
      </div>
    </div>

    <div class="sec">他们之间的关系</div>${rels}

    <div class="sec">故事(${d.stories.length})</div>${stories}

    <label>再记一笔</label>
    <textarea id="pairStory" style="min-height:70px"
      placeholder="例:去年年会上两人当众吵了一架,之后再没同框过。"></textarea>
    <div class="btn-row">
      <button class="btn primary" onclick="addPairStory(${a},${b})">保存这段故事</button>
    </div>`;
}

async function addPairStory(a, b) {
  const text = $("#pairStory").value.trim();
  if (!text) return toast("先写点内容");
  await api("/api/pair/story", { a, b, text, circle_id: S.circle.id });
  toast("记下了");
  showPair(a, b);
}

async function delRelation(rid, a, b) {
  if (!confirm("删掉这条关系?")) return;
  await api("/api/relations/delete", { id: rid });
  S.graphLoaded = false;
  await refresh();
  loadGraph();
  showPair(a, b);
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
  const sheet = $("#sheet");
  sheet.innerHTML = `
    <div class="sheet-grab"></div>
    <button class="close" onclick="closeSheets()">✕</button>
    <h3>AI 录入还没启用</h3>
    <div class="warnbox">
      需要先配置模型的 API Key。在电脑上设置环境变量
      <span class="mono">OPENAI_API_KEY</span>,然后重启服务即可。
    </div>
    <div class="hint">启用后可以:粘一段话、或直接丢一张聊天截图进来,
      AI 会把里面的人物和关系抽成候选清单,<b>每条都附上原文摘录</b>,
      你逐条确认后才入库。其余功能不受影响,现在就能用。</div>`;
  sheet.classList.remove("hidden");
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
        <label class="hstack" style="gap:5px">
          <input type="radio" name="pm${i}" class="pmerge" data-i="${i}"
                 value="merge" checked>
          <span>合并进「${esc(p.matched_name)}」</span></label>
        <label class="hstack" style="gap:5px">
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
        <div class="meta">${esc(p.dept || "")} ${esc(p.title || "")}</div>
        ${choice}
      </div>
    </div>`;
  }).join("");

  const rRows = d.relations.map((r, i) => `
    <div class="card">
      <div style="display:flex;gap:10px;align-items:flex-start">
        <input type="checkbox" class="rchk" data-i="${i}" checked style="margin-top:3px">
        <div style="flex:1;min-width:0">
          <div class="blurable"><b>${esc(r.a_name)}</b>
            <span class="dimtext">—</span> <b>${esc(r.b_name)}</b></div>
          <div style="display:flex;gap:6px;margin-top:7px;flex-wrap:wrap">
            <select class="rkind" data-i="${i}" style="flex:1;min-width:110px;padding:7px;font-size:14px">
              ${kinds.map(k => `<option ${k === r.kind ? "selected" : ""}>${esc(k)}</option>`).join("")}
            </select>
            <select class="rstr" data-i="${i}" style="width:132px;padding:7px;font-size:14px">
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

  const sheet = $("#sheet");
  sheet.innerHTML = `
    <div class="sheet-grab"></div>
    <button class="close" onclick="closeSheets()">✕</button>
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
    </div>`;
  sheet.classList.remove("hidden");

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

function renderPeople() {
  const q = ($("#peopleSearch").value || "").trim().toLowerCase();
  const list = S.people.filter(p =>
    !q || (p.name + p.dept + p.title + p.tags).toLowerCase().includes(q));
  $("#peopleList").innerHTML = list.length
    ? list.map(p => `
      <div class="row" onclick="switchView('graph');setTimeout(()=>{showPerson(${p.id});GraphView.centerOn(${p.id},bottomInset()+240)},60)">
        ${avatar(p.id, p.name, 34)}
        <div class="main">
          <div class="nm blurable">${esc(p.name)}${
            p.is_me ? ' <span class="tag">我</span>' : ""}</div>
          <div class="meta">${esc(p.dept || "—")} ${esc(p.title || "")}</div>
        </div><span class="dimtext">›</span>
      </div>`).join("")
    : `<div class="dimtext" style="padding:24px 0;text-align:center">
         ${S.people.length ? "没有匹配的人" : "这个圈子里还没有人"}</div>`;
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
        <span style="font-size:19px">${esc(c.icon || "🌐")}</span>
        <div class="main">
          <div class="nm">${esc(c.name)}</div>
          <div class="meta">${esc(c.kind)} · ${c.people} 人 · ${c.relations} 条关系</div>
        </div>
        <button class="btn" style="padding:6px 10px;font-size:13px"
          onclick="renameCircle(${c.id})">改名</button>
        <button class="btn danger" style="padding:6px 10px;font-size:13px"
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
      <label style="margin-top:0">人员名单(每行一人:姓名,部门,职位)</label>
      <textarea id="rosterText" style="min-height:80px"
        placeholder="张三,技术部,后端工程师&#10;李四,市场部,销售经理"></textarea>
      <div class="btn-row"><button class="btn" id="rosterGo">预览并导入</button></div>
      <div id="rosterOut"></div>
    </div>
    <div class="card">
      <label style="margin-top:0">关系(每行一条:人名-人名:关系 强度)</label>
      <textarea id="bulkText" style="min-height:80px"
        placeholder="张三-李四:情敌3&#10;张三 -> 王五 : 提携 2"></textarea>
      <label style="display:flex;align-items:center;gap:8px">
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
      <div class="hint" style="margin:0">全库共 ${st.counts.people} 人 ·
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
    <div class="card"><div class="hint" style="margin:0">
      ${st.llm_configured
        ? `已启用 · <span class="mono">${esc(st.llm_model)}</span>`
        : '未配置。设置环境变量 <span class="mono">OPENAI_API_KEY</span> 后重启服务。'}
    </div></div>

    <div class="sec">外观</div>
    <div class="card"><div class="hint" style="margin:0">
      默认深色。顶栏的 ☀/☾ 切换深浅,🎨 在「灰阶」和「按派系着色」之间切换。<br>
      灰阶模式下颜色只出现在两个地方:「我」和<b style="color:var(--neg-ink)">负向关系</b> ——
      让矛盾成为画面上唯一跳出来的东西。
    </div></div>

    <div class="sec">隐私</div>
    <div class="card"><div class="hint" style="margin:0">
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
      `<div class="card"><div class="hint" style="margin:0">` +
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

boot().catch(e => {
  document.body.innerHTML =
    `<div style="padding:30px;color:#e66767;font:15px system-ui">
       启动失败:${esc(e.message)}</div>`;
});
