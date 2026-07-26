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

function sheetInset() {
  const sh = document.querySelector(".sheet:not(.hidden)");
  return sh ? sh.getBoundingClientRect().height : 0;
}

/* ---------------- 启动 ---------------- */

async function boot() {
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
      $("#circleMenu").classList.add("hidden");
  });

  $("#fitBtn").onclick = () => { closeSheets(); GraphView.fit(); };

  bindAiBar();
  await refresh();

  const saved = +localStorage.getItem("circle");
  S.circle = S.state.circles.find(c => c.id === saved) || S.state.circles[0];
  paintCircleBtn();
  await loadGraph();
}

async function refresh() {
  S.state = await api("/api/state");
  if (S.circle) {
    S.circle = S.state.circles.find(c => c.id === S.circle.id) || S.state.circles[0];
  }
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

function toggleCircleMenu(e) {
  e.stopPropagation();
  const m = $("#circleMenu");
  if (!m.classList.contains("hidden")) return m.classList.add("hidden");

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
      m.classList.add("hidden");
      switchCircle(+b.dataset.cid);
    };
  });
  m.querySelector('[data-act="new"]').onclick = () => {
    m.classList.add("hidden"); newCircle();
  };
  m.querySelector('[data-act="manage"]').onclick = () => {
    m.classList.add("hidden"); switchView("settings");
  };
  m.classList.remove("hidden");
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
    const g = await api("/api/graph?" + cq());
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
    requestAnimationFrame(() => GraphView.fit(90));
    S.graphLoaded = true;
    $("#legend").innerHTML =
      `<b>${g.nodes.length}</b> 人 · <b>${g.edges.length}</b> 条关系<br>` +
      `实线正向 · <span style="color:var(--neg)">虚线负向</span><br>` +
      `♥情感 ¥利益 ▪职场 ●社交 ✎学缘 ⌂亲缘`;
  } catch (e) {
    toast(e.message);
  }
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
  $("#aiFile").onchange = async e => {
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
  };
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
  const newPeople = d.persons.filter(p => p.action !== "update");

  const pRows = newPeople.map((p, i) => `
    <div class="row">
      <input type="checkbox" class="pchk" data-i="${i}" checked>
      <div class="main">
        <div class="nm blurable">${esc(p.name)}
          ${p.match_type === "fuzzy"
            ? `<span class="tag warn">疑似已有:${esc(p.matched_name)}</span>`
            : '<span class="tag">新建</span>'}</div>
        <div class="meta">${esc(p.dept || "")} ${esc(p.title || "")}</div>
      </div>
    </div>`).join("");

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

    <div class="sec">人物(${newPeople.length})</div>
    <div class="list">${pRows || '<div class="dimtext">没有新人物</div>'}</div>

    <div class="sec">关系(${d.relations.length})</div>
    ${rRows || '<div class="dimtext">没抽到关系 —— 换个说法再试,或手动录入</div>'}

    <div class="btn-row">
      <button class="btn primary" id="reviewOk">确认入库</button>
      <button class="btn" onclick="closeSheets()">放弃</button>
    </div>`;
  sheet.classList.remove("hidden");

  $("#reviewOk").onclick = async () => {
    const persons = newPeople.map((p, i) => ({
      ...p, accepted: $(`.pchk[data-i="${i}"]`).checked }));
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
      <div class="row" onclick="switchView('graph');setTimeout(()=>{showPerson(${p.id});GraphView.centerOn(${p.id},260)},60)">
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

    <div class="sec">隐私</div>
    <div class="card"><div class="hint" style="margin:0">
      · 服务只监听本机和 Tailscale,公网扫不到<br>
      · 数据只存在这台电脑上,不上传任何地方<br>
      · 顶栏的 🕶 一键把所有人名打码,防止手机被人瞥见<br>
      · <b>不要把 data 目录提交到任何公开仓库</b>
    </div></div>`;

  $("#meSel").onchange = async e => {
    if (!e.target.value) return;
    await api("/api/people/me", { id: +e.target.value });
    await refresh(); S.graphLoaded = false; toast("已设置");
  };

  $("#rosterGo").onclick = async () => {
    const d = await api("/api/import/roster/preview", { text: $("#rosterText").value });
    if (!d.rows.length) return toast("没解析出内容");
    const n = d.rows.filter(r => r.status !== "skip").length;
    if (!confirm(`将写入 ${n} 人到「${S.circle.name}」,继续?`)) return;
    const res = await api("/api/import/roster/commit",
      { rows: d.rows, circle_id: S.circle.id });
    $("#rosterText").value = "";
    S.graphLoaded = false; await refresh(); renderSettings();
    toast(`新建 ${res.created} 人,更新 ${res.updated} 人`);
  };

  $("#bulkGo").onclick = async () => {
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
    $("#bulkText").value = "";
    S.graphLoaded = false; await refresh(); renderSettings();
    toast(`写入 ${res.relations} 条关系` +
      (res.created_people ? `,新建 ${res.created_people} 人` : ""));
  };

  $("#exportBtn").onclick = async () => {
    const d = await api("/api/export");
    delete d._saved_to;
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "relation-graph-backup.json";
    a.click();
    toast("已导出(电脑上也存了一份)");
  };
  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      const res = await api("/api/import", { payload, replace: false });
      S.graphLoaded = false; await refresh(); renderSettings();
      toast(`导入 ${res.people} 人 / ${res.relations} 条关系`);
    } catch (err) { toast("导入失败:" + err.message); }
  };
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
