/* 应用逻辑:五个页面的视图与交互。原生 JS,无框架、无构建。 */

const S = {
  state: null,
  people: [],
  view: "graph",
  planTab: "brief",
  inputTab: "rel",
  target: null,       // 谋划页当前针对的人
  graphLoaded: false,
};

const STRENGTH_LABEL = {
  3: "铁杆", 2: "关系不错", 1: "略有交情", 0: "中性",
  "-1": "略有嫌隙", "-2": "有明显矛盾", "-3": "势不两立",
};

/* ---------------- 基础工具 ---------------- */

async function api(path, body) {
  const opt = body
    ? { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body) }
    : {};
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({ error: "返回的不是 JSON" }));
  if (j && j.error) throw new Error(j.error);
  return j;
}

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
}

let toastTimer;
function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

function $(sel) { return document.querySelector(sel); }

function strengthTag(w) {
  const cls = w > 0 ? "pos" : (w < 0 ? "neg" : "");
  return `<span class="tag ${cls}">${w > 0 ? "+" : ""}${w} ${STRENGTH_LABEL[w] || ""}</span>`;
}

function peopleDatalist(id) {
  return `<datalist id="${id}">` +
    S.people.map(p =>
      `<option value="${esc(p.name)}">${esc(p.dept || "")} ${esc(p.title || "")}</option>`
    ).join("") + "</datalist>";
}

function idByName(name) {
  const p = S.people.find(x => x.name === String(name || "").trim());
  return p ? p.id : null;
}

/* ---------------- 启动 ---------------- */

async function boot() {
  GraphView.init({ onNodeTap: showNodeCard });

  document.querySelectorAll(".navbtn").forEach(b => {
    b.onclick = () => switchView(b.dataset.view);
  });
  document.body.addEventListener("click", e => {
    const g = e.target.closest("[data-goto]");
    if (g) switchView(g.dataset.goto);
  });

  $("#maskBtn").onclick = () => {
    document.body.classList.toggle("masked");
    $("#maskBtn").classList.toggle("on", document.body.classList.contains("masked"));
    localStorage.setItem("masked", document.body.classList.contains("masked") ? "1" : "");
  };
  if (localStorage.getItem("masked")) {
    document.body.classList.add("masked");
    $("#maskBtn").classList.add("on");
  }

  $("#fitBtn").onclick = () => GraphView.fit();
  $("#seedBtn2").onclick = loadSeed;

  document.querySelectorAll("#planTabs .tab").forEach(t => {
    t.onclick = () => {
      document.querySelectorAll("#planTabs .tab").forEach(x => x.classList.remove("on"));
      t.classList.add("on");
      S.planTab = t.dataset.plan;
      renderPlan();
    };
  });
  document.querySelectorAll("#inputTabs .tab").forEach(t => {
    t.onclick = () => {
      document.querySelectorAll("#inputTabs .tab").forEach(x => x.classList.remove("on"));
      t.classList.add("on");
      S.inputTab = t.dataset.input;
      renderInput();
    };
  });

  $("#peopleSearch").addEventListener("input", renderPeopleList);

  await refresh();
  await loadGraph();
}

async function refresh() {
  S.state = await api("/api/state");
  S.people = (await api("/api/people")).people;
}

function switchView(name) {
  S.view = name;
  document.querySelectorAll(".view").forEach(v => v.classList.add("hidden"));
  $("#view-" + name).classList.remove("hidden");
  document.querySelectorAll(".navbtn").forEach(b =>
    b.classList.toggle("on", b.dataset.view === name));
  $("#viewTitle").textContent =
    ({ graph: "图谱", people: "查人", plan: "谋划", input: "录入", settings: "设置" })[name];

  if (name === "graph") { if (!S.graphLoaded) loadGraph(); else GraphView.fit(); }
  if (name === "people") renderPeopleList();
  if (name === "plan") renderPlan();
  if (name === "input") renderInput();
  if (name === "settings") renderSettings();
}

/* ---------------- 图谱 ---------------- */

async function loadGraph() {
  try {
    const g = await api("/api/graph");
    if (!g.nodes.length) {
      $("#graphEmpty").classList.remove("hidden");
      $("#graphStat").textContent = "";
      return;
    }
    $("#graphEmpty").classList.add("hidden");
    GraphView.render(g);
    requestAnimationFrame(() => GraphView.fit());
    S.graphLoaded = true;
    $("#graphStat").textContent =
      `${g.nodes.length} 人 · ${g.edges.length} 条关系 · ${g.faction_count} 个圈子` +
      `　(服务端算好坐标 ${g.compute_ms}ms)`;
  } catch (e) {
    toast(e.message);
  }
}

async function showNodeCard(pid) {
  const card = $("#nodeCard");
  if (pid === null) {
    card.classList.add("hidden");
    GraphView.focus(null);
    return;
  }
  GraphView.focus(pid);
  const d = await api("/api/person?id=" + pid);
  const p = d.person;
  const rels = d.relations.map(r => {
    const other = r.a_id === pid ? r.b_name : r.a_name;
    return `<div class="row"><div class="main">
        <div class="nm blurable">${esc(other)}</div>
        <div class="meta">${esc(r.kind)}${r.notes ? " · " + esc(r.notes) : ""}</div>
      </div>${strengthTag(r.strength)}</div>`;
  }).join("") || '<div class="dimtext">还没有记录任何关系</div>';

  card.innerHTML = `
    <button class="btn close" onclick="showNodeCard(null)">✕</button>
    <h3 class="blurable">${esc(p.name)}${p.is_me ? " <span class='tag'>我</span>" : ""}</h3>
    <div class="sub">${esc(p.dept || "")} ${esc(p.title || "")}</div>
    <div class="btn-row" style="margin-top:0">
      <button class="btn primary" onclick="planFor(${pid})">对他谋划</button>
      <button class="btn" onclick="openPerson(${pid})">完整档案</button>
    </div>
    <h4 style="margin:16px 0 6px;font-size:14px">关系(${d.relations.length})</h4>
    <div class="list" style="margin-top:0">${rels}</div>`;
  card.classList.remove("hidden");
}

/* ---------------- 查人 ---------------- */

function renderPeopleList() {
  const q = ($("#peopleSearch").value || "").trim().toLowerCase();
  const list = S.people.filter(p =>
    !q || (p.name + p.dept + p.title + p.tags).toLowerCase().includes(q));
  $("#peopleList").innerHTML = list.length
    ? list.map(p => `
      <div class="row" onclick="openPerson(${p.id})">
        <div class="main">
          <div class="nm blurable">${esc(p.name)}${p.is_me ? " <span class='tag'>我</span>" : ""}</div>
          <div class="meta">${esc(p.dept || "—")} ${esc(p.title || "")}</div>
        </div>
        <span class="dimtext">›</span>
      </div>`).join("")
    : '<div class="dimtext" style="padding:20px 0;text-align:center">没有匹配的人</div>';
}

async function openPerson(pid) {
  switchView("people");
  const d = await api("/api/person?id=" + pid);
  const p = d.person;

  const rels = d.relations.map(r => {
    const other = r.a_id === pid ? r.b_name : r.a_name;
    return `<div class="row"><div class="main">
      <div class="nm blurable">${esc(other)}</div>
      <div class="meta">${esc(r.kind)}${r.notes ? " · " + esc(r.notes) : ""}</div>
    </div>${strengthTag(r.strength)}
    <button class="btn" style="padding:6px 10px"
      onclick="delRelation(${r.id},${pid})">删</button></div>`;
  }).join("") || '<div class="dimtext">还没有记录任何关系</div>';

  const evs = d.events.map(e => `
    <div class="card"><div class="blurable">${esc(e.text)}</div>
      <div class="hint">${new Date(e.happened_at * 1000).toLocaleDateString("zh-CN")}</div>
    </div>`).join("") || '<div class="dimtext">还没有相关事件</div>';

  $("#personCard").innerHTML = `
    <button class="btn close" onclick="closePerson()">✕</button>
    <h3 class="blurable">${esc(p.name)}${p.is_me ? " <span class='tag'>我</span>" : ""}</h3>
    <div class="sub">${esc(p.dept || "")} ${esc(p.title || "")}</div>
    <div class="btn-row" style="margin-top:0">
      <button class="btn primary" onclick="planFor(${pid})">对他谋划</button>
      <button class="btn" onclick="markMe(${pid})">设为「我」</button>
      <button class="btn danger" onclick="delPerson(${pid})">删除此人</button>
    </div>
    <h4 style="margin:18px 0 6px;font-size:14px">关系(${d.relations.length})</h4>
    <div class="list" style="margin-top:0">${rels}</div>
    <h4 style="margin:18px 0 6px;font-size:14px">相关事件(${d.events.length})</h4>
    ${evs}`;
  $("#personCard").classList.remove("hidden");
}

function closePerson() { $("#personCard").classList.add("hidden"); }

async function markMe(pid) {
  await api("/api/people/me", { id: pid });
  await refresh();
  toast("已设为「我」");
  openPerson(pid);
}

async function delPerson(pid) {
  if (!confirm("删除这个人?与他相关的所有关系也会一并删除。")) return;
  await api("/api/people/delete", { id: pid });
  await refresh();
  closePerson();
  S.graphLoaded = false;
  renderPeopleList();
  toast("已删除");
}

async function delRelation(rid, pid) {
  await api("/api/relations/delete", { id: rid });
  S.graphLoaded = false;
  toast("已删除这条关系");
  openPerson(pid);
}

/* ---------------- 谋划 ---------------- */

function planFor(pid) {
  S.target = pid;
  S.planTab = "brief";
  document.querySelectorAll("#planTabs .tab").forEach(x =>
    x.classList.toggle("on", x.dataset.plan === "brief"));
  switchView("plan");
}

async function renderPlan() {
  const body = $("#planBody");
  if (S.planTab === "brief") return renderBrief(body);
  body.innerHTML = '<div class="dimtext">计算中…</div>';
  try {
    if (S.planTab === "factions") return renderFactions(body);
    if (S.planTab === "key") return renderKey(body);
    if (S.planTab === "tri") return renderTriangles(body);
  } catch (e) { body.innerHTML = `<div class="warnbox">${esc(e.message)}</div>`; }
}

async function renderBrief(body) {
  const opts = S.people.map(p =>
    `<option value="${p.id}" ${p.id === S.target ? "selected" : ""}>${esc(p.name)} — ${esc(p.dept || "")}</option>`).join("");
  const picker = `<label>针对谁</label>
    <select id="targetSel"><option value="">— 选一个人 —</option>${opts}</select>`;

  if (!S.target) {
    body.innerHTML = picker +
      '<div class="card" style="margin-top:14px"><div class="hint">' +
      '选一个人,这里会给出:谁跟他有矛盾且我拉得动、他在哪个圈子、' +
      '我该托谁引荐、以及他周围哪些三角关系不稳定。</div></div>';
    $("#targetSel").onchange = e => {
      S.target = e.target.value ? +e.target.value : null;
      renderPlan();
    };
    return;
  }

  body.innerHTML = picker + '<div class="dimtext" style="margin-top:14px">计算中…</div>';
  $("#targetSel").onchange = e => {
    S.target = e.target.value ? +e.target.value : null;
    renderPlan();
  };

  const b = await api("/api/analysis/brief?id=" + S.target);
  if (b.error) { body.innerHTML = picker + `<div class="warnbox">${esc(b.error)}</div>`; return; }

  const allies = (b.allies.candidates || []).map((c, i) => `
    <div class="row">
      <div class="num" style="color:var(--dim);width:22px">${i + 1}</div>
      <div class="main">
        <div class="nm blurable">${esc(c.name)} <span class="dimtext">${esc(c.dept)}</span></div>
        <div class="meta">与目标的矛盾:${c.conflict_kinds.map(k => esc(k)).join("、")}
          (烈度 ${c.conflict})</div>
        <div class="meta">${esc(c.approach)}</div>
      </div>
      <div class="num">${c.score}</div>
    </div>`).join("") ||
    '<div class="dimtext">没找到跟他有矛盾的人 —— 这个目标目前没有明显的对立面</div>';

  const intro = b.intro && b.intro.path
    ? `<div class="card"><h4>引荐路径</h4>
        <div class="blurable" style="font-size:16px">
          ${b.intro.path.map(s => esc(s.name)).join(" → ")}</div>
        <div class="hint">${b.intro.hops} 跳。沿正向关系走,优先选交情最铁的链路。</div></div>`
    : `<div class="card"><h4>引荐路径</h4>
        <div class="dimtext">${esc((b.intro && b.intro.reason) || "还没设置「我是谁」,去设置页指定一下")}</div></div>`;

  const fac = b.faction
    ? `<div class="card"><h4>他所在的圈子</h4>
        <div>共 ${b.faction.size} 人,核心是
          <b class="blurable">${esc(b.faction.core ? b.faction.core.name : "—")}</b></div>
        <div style="margin-top:6px">${b.faction.members.slice(0, 12).map(m =>
          `<span class="tag blurable">${esc(m.name)}</span>`).join("")}</div>
        ${b.same_faction_as_me ? '<div class="hint">⚠ 你和他在同一个圈子里。</div>' : ""}
      </div>`
    : "";

  const tris = (b.triangles.triangles || []).slice(0, 5).map(t => `
    <div class="card">
      <div class="blurable"><b>${t.members.map(m => esc(m.name)).join(" — ")}</b></div>
      <div class="meta dimtext">${esc(t.pattern)} · 撬动价值 ${t.leverage}</div>
      <div class="hint blurable">${esc(t.hint)}</div>
    </div>`).join("") || '<div class="dimtext">他周围没有不稳定的三角</div>';

  body.innerHTML = picker + `
    <div class="card" style="margin-top:14px">
      <h4 class="blurable">${esc(b.target.name)}</h4>
      <div class="dimtext">${esc(b.target.dept)} ${esc(b.target.title)}</div>
    </div>
    <h4 style="margin:16px 0 8px">可结盟名单(与他有矛盾,且我拉得动)</h4>
    <div class="list" style="margin-top:0">${allies}</div>
    <h4 style="margin:18px 0 8px">其他</h4>
    ${intro}${fac}
    <h4 style="margin:18px 0 8px">他周围的不稳定三角</h4>
    ${tris}`;
}

async function renderFactions(body) {
  const d = await api("/api/analysis/factions");
  const list = d.factions.filter(f => f.size >= 2);
  if (!list.length) { body.innerHTML = '<div class="dimtext">数据还太少,聚不出圈子</div>'; return; }

  const cards = list.map((f, i) => {
    const color = GraphView.factionColor(f.id);
    return `<div class="card">
      <h4><span style="display:inline-block;width:11px;height:11px;border-radius:50%;
        background:${color};margin-right:7px"></span>圈子 ${i + 1} · ${f.size} 人</h4>
      <div>核心:<b class="blurable">${esc(f.core ? f.core.name : "—")}</b></div>
      <div style="margin-top:7px">${f.members.map(m =>
        `<span class="tag blurable">${esc(m.name)}</span>`).join("")}</div>
      ${f.straddlers.length ? `<div class="hint">骑墙(同时跟别的圈子交好):
        ${f.straddlers.map(s => `<b class="blurable">${esc(s.name)}</b>`).join("、")}</div>` : ""}
    </div>`;
  }).join("");

  const tens = d.tensions.length
    ? `<h4 style="margin:16px 0 8px">圈子之间的对立</h4>` + d.tensions.map(t => {
        const ia = list.findIndex(f => f.id === t.a), ib = list.findIndex(f => f.id === t.b);
        if (ia < 0 || ib < 0) return "";
        return `<div class="row"><div class="main">圈子 ${ia + 1} ↔ 圈子 ${ib + 1}</div>
          <div class="num" style="color:var(--neg)">${t.hostility}</div></div>`;
      }).join("")
    : "";

  body.innerHTML = cards + tens +
    '<div class="card"><div class="hint">圈子是用 Louvain 社区发现算法从<b>正向关系</b>' +
    '里自动聚出来的 —— 敌对关系不构成"一伙的"。核心 = 圈内连接最强的人;' +
    '骑墙 = 对外连接占比超过四成的人。</div></div>';
}

async function renderKey(body) {
  const d = await api("/api/analysis/key?limit=20");
  body.innerHTML = `<div class="list" style="margin-top:0">` +
    d.people.map((p, i) => `
      <div class="row" onclick="openPerson(${p.id})">
        <div class="num" style="color:var(--dim);width:22px">${i + 1}</div>
        <div class="main">
          <div class="nm blurable">${esc(p.name)}</div>
          <div class="meta">${esc(p.dept)} · ${p.friends} 个正向关系 / ${p.enemies} 个负向</div>
        </div>
        <div class="num">${p.betweenness_pct}%</div>
      </div>`).join("") + "</div>" +
    '<div class="card"><div class="hint">百分比是<b>中介中心性</b>:有多少对人之间的' +
    '最短联络路径必须经过此人。数值越高越绕不开 —— 想推动事情,这些人是关键节点;' +
    '想封锁消息,这些人是漏口。</div></div>';
}

async function renderTriangles(body) {
  const d = await api("/api/analysis/triangles?limit=40");
  if (!d.triangles.length) {
    body.innerHTML = '<div class="dimtext">目前没有不稳定的三角关系</div>'; return;
  }
  body.innerHTML = d.triangles.map(t => `
    <div class="card">
      <div class="blurable" style="font-size:15px"><b>${t.members.map(m => esc(m.name)).join(" — ")}</b></div>
      <div style="margin:6px 0">${t.edges.map(e =>
        `<span class="tag ${e.w > 0 ? "pos" : "neg"} blurable">${esc(e.a_name)}–${esc(e.b_name)} ${e.w > 0 ? "+" : ""}${e.w}</span>`).join("")}</div>
      <div class="meta dimtext">${esc(t.pattern)} · 撬动价值 ${t.leverage}</div>
      <div class="hint blurable">${esc(t.hint)}</div>
    </div>`).join("") +
    `<div class="card"><div class="hint">依据结构平衡理论:三条边的符号相乘为负,
     这个三角就是不稳定的 —— 它内部有张力,局势最可能在这里翻转。
     共找到 ${d.total} 个。</div></div>`;
}

/* ---------------- 录入 ---------------- */

function renderInput() {
  const b = $("#inputBody");
  ({ rel: inputRelation, event: inputEvent, story: inputStory,
     roster: inputRoster, bulk: inputBulk })[S.inputTab](b);
}

function inputRelation(b) {
  const kinds = Object.keys(S.state.kinds);
  b.innerHTML = `
    ${peopleDatalist("dlA")}
    <label>一方</label><input class="input" id="relA" list="dlA" placeholder="输入姓名">
    <label>另一方</label><input class="input" id="relB" list="dlA" placeholder="输入姓名">
    <label>关系类型</label>
    <select id="relKind">${kinds.map(k =>
      `<option value="${esc(k)}">${esc(k)}</option>`).join("")}</select>
    <label>亲疏程度 <span id="relSLabel">中性 (0)</span></label>
    <input type="range" id="relS" min="-3" max="3" step="1" value="0">
    <label>备注(可选,写清楚是怎么回事,以后自己能看懂)</label>
    <textarea id="relNote" style="min-height:70px"></textarea>
    <div class="btn-row"><button class="btn primary" id="relSave">保存</button></div>
    <div class="card" style="margin-top:14px"><div class="hint">
      有方向的关系(师徒、提携、上下级)请把师傅/提携者/上级填在"一方"。
      同一对人可以同时有多种关系,比如既是"上下级"又是"竞争"。</div></div>`;

  const sl = $("#relS");
  const upd = () => {
    const v = +sl.value;
    $("#relSLabel").textContent = `${STRENGTH_LABEL[v]} (${v > 0 ? "+" : ""}${v})`;
  };
  sl.oninput = upd; upd();

  $("#relKind").onchange = e => {
    // 选到明显正/负的类型时,自动给个合理的默认强度
    const sign = S.state.kinds[e.target.value];
    if (sign > 0 && +sl.value === 0) sl.value = 2;
    if (sign < 0 && +sl.value === 0) sl.value = -2;
    upd();
  };

  $("#relSave").onclick = async () => {
    const a = idByName($("#relA").value), bb = idByName($("#relB").value);
    if (!a || !bb) return toast("请从列表里选择已存在的人(可先去「导名单」批量建人)");
    if (a === bb) return toast("不能给同一个人建立关系");
    try {
      await api("/api/relations", {
        a_id: a, b_id: bb, kind: $("#relKind").value,
        strength: +sl.value, notes: $("#relNote").value,
      });
      S.graphLoaded = false;
      await refresh();
      toast("已保存");
      $("#relA").value = ""; $("#relB").value = ""; $("#relNote").value = "";
    } catch (e) { toast(e.message); }
  };
}

function inputEvent(b) {
  b.innerHTML = `
    ${peopleDatalist("dlE")}
    <label>发生了什么</label>
    <textarea id="evText" placeholder="例:今天会上李四当众怼了张三,陈总没表态。"></textarea>
    <label>涉及的人(逐个添加)</label>
    <input class="input" id="evPerson" list="dlE" placeholder="输入姓名后回车">
    <div id="evChips" style="margin-top:8px"></div>
    <div class="btn-row"><button class="btn primary" id="evSave">保存事件</button></div>
    <div class="card" style="margin-top:14px"><div class="hint">
      事件是关系的<b>证据链</b>。以后翻某人的档案时,能看到当初为什么给他打这个分,
      而不只剩一个孤零零的数字。</div></div>`;

  const chosen = [];
  const draw = () => {
    $("#evChips").innerHTML = chosen.map((id, i) => {
      const p = S.people.find(x => x.id === id);
      return `<span class="tag blurable" onclick="void 0" data-i="${i}">
        ${esc(p ? p.name : id)} ✕</span>`;
    }).join("");
    $("#evChips").querySelectorAll(".tag").forEach(t => {
      t.onclick = () => { chosen.splice(+t.dataset.i, 1); draw(); };
    });
  };

  $("#evPerson").onchange = e => {
    const id = idByName(e.target.value);
    if (id && !chosen.includes(id)) chosen.push(id);
    e.target.value = "";
    draw();
  };

  $("#evSave").onclick = async () => {
    const text = $("#evText").value.trim();
    if (!text) return toast("先写点内容");
    await api("/api/events", { text, people: chosen });
    toast("已记下");
    $("#evText").value = ""; chosen.length = 0; draw();
  };
}

function inputStory(b) {
  if (!S.state.llm_configured) {
    b.innerHTML = `<div class="warnbox">
      还没有配置模型 API Key,这个功能暂时用不了。<br><br>
      在 Windows 上设置环境变量 <span class="mono">OPENAI_API_KEY</span> 后重启服务即可。
      其余所有功能都不受影响。</div>
      <div class="card"><div class="hint">这个功能的作用:粘一段话进去,
      模型把里面的人物和关系抽成候选清单,<b>每条都附上原文摘录</b>,
      你逐条审核后才入库。模型会看错,但审核这一步兜得住。</div></div>`;
    return;
  }
  b.innerHTML = `
    <label>粘贴一段描述</label>
    <textarea id="storyText" style="min-height:170px"
      placeholder="例:张三是技术部的老人,跟李四关系一直不错,两人一起做过好几个项目。但张三和市场部的王五因为去年那个项目的归属问题闹得很僵,现在见面都不打招呼……"></textarea>
    <div class="btn-row"><button class="btn primary" id="storyGo">让模型解析</button></div>
    <div id="storyResult"></div>
    <div class="card" style="margin-top:14px"><div class="hint">
      用的是 <span class="mono">${esc(S.state.llm_model)}</span>。
      小模型会漏抽、也会看错人,所以每条候选都附了<b>原文摘录</b>,
      你扫一眼就知道它有没有编。确认无误的才会入库。</div></div>`;

  $("#storyGo").onclick = async () => {
    const text = $("#storyText").value.trim();
    if (!text) return toast("先粘一段内容");
    $("#storyGo").disabled = true;
    $("#storyGo").textContent = "解析中…";
    try {
      const d = await api("/api/llm/parse", { text });
      renderStoryReview(d);
    } catch (e) {
      $("#storyResult").innerHTML = `<div class="warnbox">${esc(e.message)}</div>`;
    } finally {
      $("#storyGo").disabled = false;
      $("#storyGo").textContent = "让模型解析";
    }
  };
}

function renderStoryReview(d) {
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
        <input type="checkbox" class="rchk" data-i="${i}" checked style="margin-top:4px">
        <div style="flex:1;min-width:0">
          <div class="blurable"><b>${esc(r.a_name)}</b> ↔ <b>${esc(r.b_name)}</b></div>
          <div style="display:flex;gap:7px;margin-top:7px;flex-wrap:wrap">
            <select class="rkind" data-i="${i}" style="flex:1;min-width:110px;padding:7px">
              ${kinds.map(k => `<option ${k === r.kind ? "selected" : ""}>${esc(k)}</option>`).join("")}
            </select>
            <select class="rstr" data-i="${i}" style="width:130px;padding:7px">
              ${[3, 2, 1, 0, -1, -2, -3].map(v =>
                `<option value="${v}" ${v === r.strength ? "selected" : ""}>${v > 0 ? "+" : ""}${v} ${STRENGTH_LABEL[v]}</option>`).join("")}
            </select>
          </div>
          <div class="evidence blurable">原文:${esc(r.evidence) || "(模型没给出处 —— 建议取消勾选)"}</div>
          <div class="meta dimtext">模型把握 ${Math.round(r.confidence * 100)}%
            ${!r.a_id || !r.b_id ? " · 含新人物" : ""}</div>
        </div>
      </div>
    </div>`).join("");

  $("#storyResult").innerHTML = `
    <h4 style="margin:18px 0 8px">人物(${newPeople.length})</h4>
    <div class="list" style="margin-top:0">${pRows || '<div class="dimtext">没有新人物</div>'}</div>
    <h4 style="margin:18px 0 8px">关系(${d.relations.length})</h4>
    ${rRows || '<div class="dimtext">没抽到关系 —— 换个说法再试,或手动录入</div>'}
    <div class="btn-row">
      <button class="btn primary" id="storyCommit">确认入库</button>
      <button class="btn" onclick="document.getElementById('storyResult').innerHTML=''">放弃</button>
    </div>`;

  $("#storyCommit").onclick = async () => {
    const persons = newPeople.map((p, i) => ({
      ...p, accepted: $(`.pchk[data-i="${i}"]`).checked,
    }));
    const relations = d.relations.map((r, i) => ({
      ...r,
      kind: $(`.rkind[data-i="${i}"]`).value,
      strength: +$(`.rstr[data-i="${i}"]`).value,
      accepted: $(`.rchk[data-i="${i}"]`).checked,
    }));
    const res = await api("/api/llm/commit", { story: d.story, persons, relations });
    S.graphLoaded = false;
    await refresh();
    toast(`入库:新建 ${res.people_created} 人 / ${res.relations} 条关系`);
    $("#storyResult").innerHTML = "";
    $("#storyText").value = "";
  };
}

function inputRoster(b) {
  b.innerHTML = `
    <label>粘贴人员名单(每行一人:姓名,部门,职位)</label>
    <textarea id="rosterText" style="min-height:170px"
      placeholder="张三,技术部,后端工程师&#10;李四,市场部,销售经理&#10;王五,财务部"></textarea>
    <div class="btn-row"><button class="btn primary" id="rosterPreview">预览</button></div>
    <div id="rosterResult"></div>
    <div class="card" style="margin-top:14px"><div class="hint">
      支持逗号、制表符、竖线分隔 —— 从 Excel 直接复制一列过来也能认。
      只填姓名也可以,部门职位以后再补。</div></div>`;

  $("#rosterPreview").onclick = async () => {
    const d = await api("/api/import/roster/preview", { text: $("#rosterText").value });
    if (!d.rows.length) return toast("没解析出内容");
    const counts = { new: 0, update: 0, skip: 0 };
    d.rows.forEach(r => counts[r.status]++);
    $("#rosterResult").innerHTML = `
      <div class="card" style="margin-top:14px">
        新建 ${counts.new} 人 · 更新 ${counts.update} 人 · 跳过 ${counts.skip} 条
      </div>
      <div class="list" style="margin-top:0">` +
      d.rows.map(r => `<div class="row"><div class="main">
        <div class="nm blurable">${esc(r.name)}</div>
        <div class="meta">${esc(r.dept)} ${esc(r.title)} · ${esc(r.message)}</div>
      </div></div>`).join("") + `</div>
      <div class="btn-row"><button class="btn primary" id="rosterCommit">确认写入</button></div>`;

    $("#rosterCommit").onclick = async () => {
      const res = await api("/api/import/roster/commit", { rows: d.rows });
      S.graphLoaded = false;
      await refresh();
      toast(`新建 ${res.created} 人,更新 ${res.updated} 人`);
      $("#rosterResult").innerHTML = ""; $("#rosterText").value = "";
    };
  };
}

function inputBulk(b) {
  b.innerHTML = `
    <label>批量关系(每行一条)</label>
    <textarea id="bulkText" style="min-height:170px"
      placeholder="张三-李四:敌对3&#10;张三 -> 王五 : 提携 2&#10;李四 与 赵六:朋友"></textarea>
    <label style="display:flex;align-items:center;gap:8px;margin-top:12px">
      <input type="checkbox" id="bulkAuto"> 遇到库里没有的人,自动建
    </label>
    <div class="btn-row"><button class="btn primary" id="bulkPreview">预览</button></div>
    <div id="bulkResult"></div>
    <div class="card" style="margin-top:14px"><div class="hint">
      格式:<span class="mono">人名 分隔符 人名 : 关系类型 强度</span>。
      分隔符支持 <span class="mono">-</span> <span class="mono">-></span>
      <span class="mono">与</span> <span class="mono">和</span> 等;强度可以省略,
      会按关系类型的正负给个默认值。<br>
      可用关系:${Object.keys(S.state.kinds).join("、")}</div></div>`;

  $("#bulkPreview").onclick = async () => {
    const auto = $("#bulkAuto").checked;
    const d = await api("/api/import/relations/preview",
      { text: $("#bulkText").value, auto_create: auto });
    if (!d.rows.length) return toast("没解析出内容");
    const bad = d.rows.filter(r => r.status !== "ok").length;
    $("#bulkResult").innerHTML = `
      <div class="card" style="margin-top:14px">
        可写入 ${d.rows.length - bad} 条${bad ? ` · <b style="color:var(--warn)">${bad} 条有问题</b>` : ""}
      </div>
      <div class="list" style="margin-top:0">` +
      d.rows.map(r => `<div class="row">
        <div class="main">
          <div class="nm blurable">${r.status === "ok"
            ? `${esc(r.a_name)} — ${esc(r.b_name)}` : esc(r.raw)}</div>
          <div class="meta">${r.status === "ok"
            ? `${esc(r.kind)} ${r.strength > 0 ? "+" : ""}${r.strength}` : ""}
            ${r.message ? `<span style="color:var(--warn)">${esc(r.message)}</span>` : ""}</div>
        </div>
        <span class="tag ${r.status === "ok" ? "pos" : "neg"}">
          ${r.status === "ok" ? "OK" : (r.status === "missing" ? "缺人" : "格式错")}</span>
      </div>`).join("") + `</div>
      <div class="btn-row"><button class="btn primary" id="bulkCommit">确认写入</button></div>`;

    $("#bulkCommit").onclick = async () => {
      const res = await api("/api/import/relations/commit",
        { rows: d.rows, auto_create: auto });
      S.graphLoaded = false;
      await refresh();
      toast(`写入 ${res.relations} 条关系` +
        (res.created_people ? `,新建 ${res.created_people} 人` : ""));
      $("#bulkResult").innerHTML = ""; $("#bulkText").value = "";
    };
  };
}

/* ---------------- 设置 ---------------- */

function renderSettings() {
  const st = S.state;
  const meOpts = S.people.map(p =>
    `<option value="${p.id}" ${st.me && st.me.id === p.id ? "selected" : ""}>${esc(p.name)}</option>`).join("");

  $("#settingsBody").innerHTML = `
    <div class="card">
      <h4>我是谁</h4>
      <div class="hint" style="margin-top:0;margin-bottom:8px">
        「找敌人的敌人」和「引荐路径」都要以你为起点,必须先指定。</div>
      <select id="meSel"><option value="">— 未设置 —</option>${meOpts}</select>
    </div>

    <div class="card">
      <h4>数据</h4>
      <div class="hint" style="margin-top:0">
        ${st.counts.people} 人 · ${st.counts.relations} 条关系 · ${st.counts.events} 条事件</div>
      <div class="btn-row">
        <button class="btn" id="exportBtn">导出备份</button>
        <button class="btn" id="importBtn">导入备份</button>
      </div>
      <input type="file" id="importFile" accept=".json" class="hidden">
      <div class="hint">这些数据是你一条条攒出来的,重建成本极高。
        导出的 JSON 同时会在电脑上存一份到 backups 目录。</div>
    </div>

    <div class="card">
      <h4>演示数据</h4>
      <div class="hint" style="margin-top:0">
        一个虚构的 19 人公司,可以用来试功能。人名全是编的。</div>
      <div class="btn-row"><button class="btn" id="seedBtn">载入演示数据</button></div>
    </div>

    <div class="card">
      <h4>模型</h4>
      <div class="hint" style="margin-top:0">
        ${st.llm_configured
          ? `已配置 · <span class="mono">${esc(st.llm_model)}</span>`
          : '未配置。设置环境变量 <span class="mono">OPENAI_API_KEY</span> 后重启服务。'}
      </div>
    </div>

    <div class="card">
      <h4>隐私</h4>
      <div class="hint" style="margin-top:0">
        · 服务只监听 Tailscale 网卡,公网扫不到<br>
        · 数据只存在这台电脑上,不上传任何地方<br>
        · 顶栏的 🕶 一键把所有人名打码,防止手机被人瞥见<br>
        · <b>不要把 data 目录提交到任何公开仓库</b>
      </div>
    </div>`;

  $("#meSel").onchange = async e => {
    if (!e.target.value) return;
    await api("/api/people/me", { id: +e.target.value });
    await refresh();
    S.graphLoaded = false;
    toast("已设置");
  };

  $("#exportBtn").onclick = async () => {
    const d = await api("/api/export");
    const saved = d._saved_to;
    delete d._saved_to;
    const blob = new Blob([JSON.stringify(d, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "relation-graph-backup.json";
    a.click();
    toast("已导出" + (saved ? "(电脑上也存了一份)" : ""));
  };

  $("#importBtn").onclick = () => $("#importFile").click();
  $("#importFile").onchange = async e => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      const res = await api("/api/import", { payload, replace: false });
      S.graphLoaded = false;
      await refresh();
      toast(`导入 ${res.people} 人 / ${res.relations} 条关系`);
      renderSettings();
    } catch (err) { toast("导入失败:" + err.message); }
  };

  $("#seedBtn").onclick = loadSeed;
}

async function loadSeed() {
  if (S.state.counts.people > 0 &&
      !confirm("库里已经有数据了。演示数据会合并进去(不会删除现有内容),继续?")) return;
  const res = await api("/api/seed", { replace: false });
  S.graphLoaded = false;
  await refresh();
  toast(`已载入 ${res.people} 人 / ${res.relations} 条关系`);
  switchView("graph");
  loadGraph();
}

/* 注册 Service Worker —— 让"添加到主屏幕"后能全屏离线打开外壳 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("/sw.js").catch(() => {}));
}

boot().catch(e => {
  document.body.innerHTML =
    `<div style="padding:30px;color:#e66767">启动失败:${esc(e.message)}</div>`;
});
