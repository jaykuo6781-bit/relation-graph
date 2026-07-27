/* 图谱渲染 —— 手机端只做"画",不做任何计算。
 *
 * 坐标、弧线控制点、标签落点全部由服务端算好送过来。这里只把它们拼成 SVG,
 * 平移缩放只改一个 CSS transform 由 GPU 合成 —— 没有物理循环、没有逐帧计算。
 *
 * 视觉照着参考图做:深蓝夜空 + 发光的立体球 + 流光连线。
 * 全部用 SVG 渐变实现,**不用 filter** —— iOS Safari 上 filter 极慢,
 * 用它做发光会把服务端算布局省下来的功耗全赔进去。
 *
 * 球体是四层叠出来的:
 *   1. 外光晕   更大的圆,同色径向渐变淡出到透明
 *   2. 球身     径向渐变把中心偏到左上(亮→本色→暗),这样就有了体积感
 *   3. 高光     左上一个白色小椭圆 —— 这一笔是"玻璃球"感的关键
 *   4. 细亮边   白色低透明度描边,把球从背景里"切"出来
 *
 * buildSVG() 是纯函数(payload + 样式参数 → SVG 字符串),
 * 所以对比页可以用同一份代码渲染三档不同强度,不必复制逻辑 ——
 * 保证"你在对比页看到的,就是你会得到的"。
 */

/* 三档强度,方向相同(都照参考图),只在浓淡上不同。
   **产品固定 A 档**(用户在对比页选定的),对比页已经删掉。
   B / C 留下来只作为**测试基准**:fittest.js 用它们不同的 nameSize 跑贴合
   用例(11.5 / 12.5 / 13 三个字号都不能把名字裁出视口),并用 B 生成一份
   SVG 验证边的顺序。删掉它们等于要重写那批用例,不值。 */
const GraphStyles = {
  A: { name: "A · 忠于参考图", ball: 1.15, glow: 2.9, glowOp: 0.62,
       edgeW: 1.5, edgeOp: 0.60, stars: 150, nameSize: 13, streak: true },
  B: { name: "B · 中间(测试基准)", ball: 1.0, glow: 2.3, glowOp: 0.45,
       edgeW: 1.15, edgeOp: 0.50, stars: 90, nameSize: 12.5, streak: true },
  C: { name: "C · 收敛(测试基准)", ball: 0.85, glow: 1.7, glowOp: 0.28,
       edgeW: 0.9, edgeOp: 0.42, stars: 40, nameSize: 11.5, streak: false },
};

const GraphView = (() => {
  let stage, canvas, svg;
  let data = null;
  let tx = 0, ty = 0, scale = 1;
  let cb = {};
  let settleTimer = null;
  let style = GraphStyles.A;
  /* 实际用来画的那一档。style 是用户选的,rstyle 是它经过 effectiveStyle
     按当前数据量降级之后的结果(边太多时关掉流光)。**画边的每一处都必须
     读同一个 rstyle** —— 全量渲染关了流光而增量补丁还开着的话,补出来的边
     会 stroke="url(#e1_2)" 引到一个不存在的渐变:线整条不可见,且不报错。 */
  let rstyle = GraphStyles.A;

  // 邻接索引与当前位置(见 buildIndex)
  let index = null, pos = null, byId = null;
  let lastScale = -1;              // settle 的短路:纯平移不重算
  let lod = "all";                 // 当前的名字详略档:all / key / none
  let hovered = null, hoverLocked = false;
  let dragId = null, justDragged = false, longPress = null;
  let pendingMove = null, rafId = 0;

  const LONG_PRESS_MS = 500;      // 手机上长按多久才进入拖动(用户选的)
  const RETURN_MS = 420;          // 松手后飘回原位用多久
  const now = () => (typeof performance === "object" && performance.now)
    ? performance.now() : Date.now();
  const REDUCED_MOTION = typeof matchMedia === "function" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;
  // 触屏没有"悬停"这回事;在触屏上装 mouseenter 只会换来点一下就卡住的高亮
  const CAN_HOVER = typeof matchMedia === "function" &&
    matchMedia("(hover: hover) and (pointer: fine)").matches;

  function init(opts) {
    stage = document.getElementById("stage");
    canvas = document.getElementById("canvas");
    svg = document.getElementById("svg");
    cb = opts || {};
    bindGestures();
  }

  function setStyle(s) { style = s || GraphStyles.A; rstyle = style; }

  function apply() {
    canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 90);
  }

  /* 缩放稳定后再补偿字号、再决定名字的详略。手势进行中让文字跟着缩放是自然的,
     松手后归位。绝不在每一帧改字号 —— 那会让几十个文本节点反复重排,直接发热。

     `s === lastScale` 这一句管的是**纯平移**:拖画布不改缩放,却照样一路走到
     settle,而 --gscale 被所有节点名和边标签的 calc() 引用 —— 100 个节点时
     约 500 个文本元素会为一次毫无变化的变量写入集体重排。 */
  function settle() {
    const s = +scale.toFixed(3);
    if (s === lastScale) return;
    lastScale = s;
    svg.style.setProperty("--gscale", s.toFixed(3));
    applyLod(s);
  }

  /* LOD:名字显示到什么程度。**决策只在这里做一次,逐节点的匹配交给样式引擎**
     —— #svg 上翻 .lod-key / .lod-none,CSS 里一条 `.node:not(.key) .nm{display:none}`
     就覆盖了全部节点。对 100 个节点,选择器匹配是浏览器内部的微秒级工作,
     而 JS 逐个 classList.toggle 是几毫秒;更要紧的是后者会把"缩放"变成
     "遍历一遍 DOM",而这个项目的原则就是手机上不做每帧 DOM 操作。
     settle 本来就是 90ms 防抖的,所以这里连一次遍历都不欠。

     顺带白拿一个功能:CSS 里那条 `.near/.lit/.sel/.dragging 的名字强制显示`
     让"点开某人时他和邻居的名字必显"零额外代码就成立了。 */
  function applyLod(s) {
    if (!data) return;
    const lv = GraphRender.lodLevel(
      GraphRender.lodRatio(data, s, rstyle.nameSize), lod);
    if (lv === lod) return;
    lod = lv;
    svg.classList.toggle("lod-key", lv === "key");
    svg.classList.toggle("lod-none", lv === "none");
  }

  function render(payload) {
    data = payload;
    rstyle = GraphRender.effectiveStyle(style, payload);
    svg.setAttribute("viewBox", `0 0 ${payload.width} ${payload.height}`);
    svg.setAttribute("width", payload.width);
    svg.setAttribute("height", payload.height);
    svg.innerHTML = GraphRender.buildSVG(payload, style);
    /* 换数据时必须把选中态一起清掉。以前只换 innerHTML 不动 classList,
       于是 focused 还挂着、而新 DOM 里一个 .near/.sel 都没有 ——
       CSS 让所有节点 opacity:.14、所有边 .07,整张图发暗,
       要等用户关掉卡片才恢复。 */
    svg.classList.remove("focused", "hovering");
    hovered = null; hoverLocked = false;
    buildIndex(payload);
    // 人数变了 → 同一个 scale 下的疏密也变了,LOD 必须重新判一次
    lastScale = -1;
    settle();

    svg.querySelectorAll(".node").forEach(g => {
      const pid = +g.dataset.id;
      g.addEventListener("click", ev => {
        ev.stopPropagation();
        if (justDragged) { justDragged = false; return; }   // 拖完不要顺手弹卡片
        if (cb.onNode) cb.onNode(pid);
      });
      bindNodeDrag(g, pid);
      if (CAN_HOVER) {
        g.addEventListener("mouseenter", () => setHover(pid));
        g.addEventListener("mouseleave", () => setHover(null));
      }
    });
    svg.querySelectorAll(".eg").forEach(bindEdge);
  }

  /* 单独拎出来是给增量补丁用的:补一条边时只有那一个 <g> 需要绑,
     不能再 querySelectorAll 全图重绑(旧元素上会留下两份监听)。 */
  function bindEdge(g) {
    if (!g) return;
    const hit = g.querySelector(".edge-hit");
    if (!hit) return;
    hit.addEventListener("click", ev => {
      ev.stopPropagation();
      if (cb.onEdge) cb.onEdge(+g.dataset.a, +g.dataset.b);
    });
  }

  /* ---------------- 邻接索引 ----------------
     悬停是**每动一下鼠标就触发**的,不能像点击那样每次全量 querySelectorAll。
     渲染后建一张 `节点 id → {它的边元素, 邻居 id}` 的表,
     悬停和拖动就都只碰 O(度数) 个元素,与总节点数无关。 */

  /* keepPos:增量补丁后重建索引时必须传 true。
     原因是 moveNode 会把拖动中的位置写回 payload 节点的 n.x/n.y ——
     此时无条件用 n.x 重建 pos,ox(算法排好的原位)就被污染成拖后的位置,
     松手再也飘不回去了。真正的原位只有旧 pos 记录里那一份,得留着。 */
  function buildIndex(payload, keepPos) {
    if (!keepPos) hovered = null;
    else clearHover();          // 索引马上要换,先用旧索引把高亮 class 摘干净
    const oldPos = pos;
    index = new Map();
    pos = new Map();
    for (const n of payload.nodes) {
      const kept = keepPos && oldPos ? oldPos.get(n.id) : null;
      pos.set(n.id, kept || { x: n.x, y: n.y, ox: n.x, oy: n.y });
    }
    // 建完不要扔:nodeColor 每次都 data.nodes.find() 一遍,而人物页
    // 每敲一个键都要给每一行算一次头像色,合起来是 O(人数²)
    byId = new Map(payload.nodes.map(n => [n.id, n]));
    svg.querySelectorAll(".node").forEach(g => {
      const id = +g.dataset.id;
      // 把 payload 里的节点对象一并存进来,拖动时就不必每帧 find 一遍
      index.set(id, { g, n: byId.get(id), edges: [], nbrs: new Set() });
    });
    // buildSVG 是按 payload.edges 的顺序一条条 push 的,所以下标一一对应
    const egs = svg.querySelectorAll(".eg");
    payload.edges.forEach((e, i) => {
      const g = egs[i];
      if (!g) return;
      const rec = {
        e, g,
        path: g.querySelector(".edge"),
        hit: g.querySelector(".edge-hit"),
        label: g.querySelector(".elabel"),
        grad: svg.querySelector(`#e${e.a}_${e.b}`),   // 流光渐变,可能不存在
      };
      for (const id of [e.a, e.b]) {
        const it = index.get(id);
        if (!it) continue;
        it.edges.push(rec);
        it.nbrs.add(id === e.a ? e.b : e.a);
      }
    });
  }

  /* ---------------- 悬停高亮(Obsidian 式) ----------------
     卡片打开时禁用 —— 否则悬停态和选中态两套 class 会互相打架。 */

  function setHover(pid) {
    if (!CAN_HOVER || hoverLocked || !index) return;
    if (dragId != null) return;      // 拖动中鼠标还会掠过别的球,别让它抢高亮
    if (hovered === pid) return;
    if (hovered != null) paintHover(hovered, false);
    hovered = pid;
    if (pid != null) paintHover(pid, true);
    svg.classList.toggle("hovering", pid != null);
  }

  function paintHover(pid, on) {
    const it = index.get(pid);
    if (!it) return;
    it.g.classList.toggle("hot", on);
    it.g.classList.toggle("lit", on);
    for (const rec of it.edges) rec.g.classList.toggle("lit", on);
    for (const nid of it.nbrs) {
      const nb = index.get(nid);
      if (nb) nb.g.classList.toggle("lit", on);
    }
  }

  function clearHover() {
    if (hovered != null) paintHover(hovered, false);
    hovered = null;
    svg.classList.remove("hovering");
  }

  /* ---------------- 拖动 ----------------
     这是我在整个项目里唯一开的"逐帧改 DOM"的口子。理由:它是有界的
     (只碰被拖节点的度数个元素,不是全图)、用户主动触发的、手一松就停。
     再用 requestAnimationFrame 把同一帧内的多次移动事件合并成一次。

     松手后节点自己飘回算法排好的位置(见 releaseNode),所以拖动是一个
     **查看**动作 —— 把某个球拽出来看清它连着谁,而不是重新摆放图。
     位置既不改也不落库,后端一行不用动。 */

  function moveNode(pid, x, y) {
    const p = pos.get(pid), it = index.get(pid);
    if (!p || !it) return;
    p.x = x; p.y = y;
    if (it.n) { it.n.x = x; it.n.y = y; }        // 让复位/贴合也认这个新位置
    // 整组一次性平移,不去逐个改 6 个子图形的 cx/cy
    it.g.setAttribute("transform",
      `translate(${(x - p.ox).toFixed(1)},${(y - p.oy).toFixed(1)})`);
    refreshEdgesOf(pid);
  }

  /* 端点动了,这条边身上四样东西都得跟着动:
     路径 d、命中区 d、流光渐变的 x1/y1/x2/y2(不更新线会"秃")、标签落点。 */
  function refreshEdgesOf(pid) {
    const it = index.get(pid);
    if (!it || !data) return;
    const cap = GraphRender.curveCap(data);
    for (const rec of it.edges) {
      const A = pos.get(rec.e.a), B = pos.get(rec.e.b);
      if (!A || !B) continue;
      const a = GraphRender.arc(A.x, A.y, B.x, B.y, cap, rec.e.bend);
      const d = `M${A.x.toFixed(1)},${A.y.toFixed(1)} ` +
                `Q${a.cx.toFixed(1)},${a.cy.toFixed(1)} ` +
                `${B.x.toFixed(1)},${B.y.toFixed(1)}`;
      rec.path.setAttribute("d", d);
      if (rec.hit) rec.hit.setAttribute("d", d);
      if (rec.label) {
        rec.label.setAttribute("x", a.qx.toFixed(1));
        rec.label.setAttribute("y", (a.qy - 11).toFixed(1));
      }
      if (rec.grad) {
        rec.grad.setAttribute("x1", A.x.toFixed(1));
        rec.grad.setAttribute("y1", A.y.toFixed(1));
        rec.grad.setAttribute("x2", B.x.toFixed(1));
        rec.grad.setAttribute("y2", B.y.toFixed(1));
      }
    }
  }

  function queueMove(pid, x, y) {
    pendingMove = { pid, x, y };
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const p = pendingMove; pendingMove = null;
      if (p) moveNode(p.pid, p.x, p.y);
    });
  }

  function beginDrag(pid) {
    dragId = pid;
    clearHover();
    const it = index.get(pid);
    if (it) { cancelReturn(it); it.g.classList.add("dragging"); }
    svg.classList.add("has-drag");
    // 兜底:万一还是有一段被选中了(不同 iOS 版本行为不完全一致),清掉它
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && !sel.isCollapsed) sel.removeAllRanges();
    } catch (e) {}
  }

  function endDrag() {
    if (dragId == null) return;
    const pid = dragId;
    const it = index.get(pid);
    if (it) it.g.classList.remove("dragging");
    svg.classList.remove("has-drag");
    dragId = null;

    // rAF 里可能还排着一次没落地的移动。不先清掉的话,归位动画已经起步了
    // 它才执行,会把球"弹"回松手时的位置。这里立刻结算掉再开始归位。
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
    if (pendingMove) {
      const m = pendingMove; pendingMove = null;
      if (m.pid === pid) moveNode(m.pid, m.x, m.y);
    }
    releaseNode(pid);
  }

  /* 松手后自己飘回算法排好的位置 —— Obsidian 就是这个手感:
     节点被交还给力学模拟,慢慢回到平衡点。所以"拖动"是一个**查看**的动作
     (把某个球拽出来看清它连着谁),而不是"重新摆放"。
     这里没有物理模拟可交还,就用一段缓出动画走回去,效果一样。 */
  function releaseNode(pid) {
    const p = pos.get(pid), it = index.get(pid);
    if (!p || !it) return;
    if (p.x === p.ox && p.y === p.oy) return;      // 压根没动过

    if (REDUCED_MOTION) {                          // 用户要求减少动效:直接归位
      moveNode(pid, p.ox, p.oy);
      it.g.removeAttribute("transform");
      return;
    }
    const x0 = p.x, y0 = p.y, t0 = now();
    it.g.classList.add("returning");
    const step = () => {
      const k = Math.min(1, (now() - t0) / RETURN_MS);
      const e = 1 - Math.pow(1 - k, 3);            // 缓出:先快后慢
      moveNode(pid, x0 + (p.ox - x0) * e, y0 + (p.oy - y0) * e);
      if (k < 1) { it.ret = requestAnimationFrame(step); return; }
      it.ret = 0;
      it.g.removeAttribute("transform");
      it.g.classList.remove("returning");
    };
    it.ret = requestAnimationFrame(step);
  }

  /* 归位动画是**每个节点各自一份**的 —— 上一个还在飘回去的时候
     完全可以再抓起另一个,所以句柄存在各自的索引记录里,不能用全局变量。 */
  function cancelReturn(it) {
    if (!it || !it.ret) return;
    cancelAnimationFrame(it.ret);
    it.ret = 0;
    it.g.classList.remove("returning");
  }

  /* 桌面:球上按下即进入拖动。松手时位移小于 4px 就当点击,照常弹卡片。
     手机:手指落到球上后长按 500ms 才进入拖动 —— 在这之前移动超过 8px
     就判定为"用户想平移画布",取消长按,把手势让给 stage。 */
  function bindNodeDrag(g, pid) {
    g.addEventListener("mousedown", ev => {
      if (ev.button !== 0) return;
      ev.stopPropagation();               // 不让 stage 把它当成平移
      ev.preventDefault();
      // 每次按下都清一遍:上一次拖动如果在球外面松手,就不会有 click 来清它,
      // 那面旧旗子会把下一次正常点击吞掉
      justDragged = false;
      const start = { x: ev.clientX, y: ev.clientY };
      const p0 = { x: pos.get(pid).x, y: pos.get(pid).y };
      let far = false;
      beginDrag(pid);
      const onMove = e => {
        const dx = e.clientX - start.x, dy = e.clientY - start.y;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) far = true;
        if (far) queueMove(pid, p0.x + dx / scale, p0.y + dy / scale);
      };
      const onUp = () => {
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
        justDragged = far;                // far 为假 → 当作点击,让 click 走下去
        endDrag();
      };
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
    });

    g.addEventListener("touchstart", ev => {
      if (ev.touches.length !== 1) return;
      justDragged = false;
      const t = ev.touches[0];
      const start = { x: t.clientX, y: t.clientY };
      const p0 = { x: pos.get(pid).x, y: pos.get(pid).y };
      let far = false;
      longPress = setTimeout(() => {
        longPress = null;
        beginDrag(pid);
        if (navigator.vibrate) navigator.vibrate(12);   // "抓住了"
      }, LONG_PRESS_MS);

      const onMove = e => {
        const tt = e.touches[0];
        if (!tt) return;
        const dx = tt.clientX - start.x, dy = tt.clientY - start.y;
        if (dragId === pid) {
          far = true;
          e.preventDefault();
          e.stopPropagation();
          queueMove(pid, p0.x + dx / scale, p0.y + dy / scale);
        } else if (Math.hypot(dx, dy) > 8 && longPress) {
          clearTimeout(longPress); longPress = null;   // 让位给平移
        }
      };
      const onEnd = () => {
        g.removeEventListener("touchmove", onMove);
        g.removeEventListener("touchend", onEnd);
        g.removeEventListener("touchcancel", onEnd);
        if (longPress) { clearTimeout(longPress); longPress = null; }
        justDragged = far;
        endDrag();
      };
      g.addEventListener("touchmove", onMove, { passive: false });
      g.addEventListener("touchend", onEnd);
      g.addEventListener("touchcancel", onEnd);
    }, { passive: true });
  }

  /* 复位按钮的兜底:正常情况下松手就飘回去了,这里只处理"归位动画还在半路上
     就点了复位"的情形 —— 直接掐掉动画归位,不让它跟贴合动画打架。 */
  function resetPositions() {
    if (!index || !pos || !data) return false;
    let moved = false;
    for (const [id, p] of pos) {
      cancelReturn(index.get(id));
      if (p.x === p.ox && p.y === p.oy) continue;
      moved = true;
      p.x = p.ox; p.y = p.oy;
      const it = index.get(id);
      if (it) {
        if (it.n) { it.n.x = p.ox; it.n.y = p.oy; }
        it.g.removeAttribute("transform");
      }
    }
    if (moved) for (const id of pos.keys()) refreshEdgesOf(id);
    return moved;
  }

  /* ---------------- 增量补丁 ----------------
     手动录一条关系之后**不重排整张图**。理由很硬:节点坐标只取决于
     "这个圈子里有哪些人",跟"他俩之间多了一条边"在一次增量里毫无关系。
     重排一次要 ~580ms 而且所有球都会动一下 —— 用户刚录完一条,
     最想看的是那条线出现在哪,不是满屏重新洗牌。

     所以两个已有节点之间加边 = 往 <g class="edges"> 里塞一个 <g>,布局一动不动。
     只要有一端是图上还没有的人(新建的人),就返回 false 让调用方走整图重排。

     边的字符串走 GraphRender.edgeMarkup —— 和 buildSVG 用的是同一份代码。
     画边的字符串全项目只能有一份,两份是增量补丁最大的风险来源。 */

  function edgeEl(a, b) {
    return svg.querySelector(`.eg[data-a="${a}"][data-b="${b}"]`);
  }

  /* 把一段 SVG 字符串变成元素。用临时 <svg> 容器 + innerHTML,
     而不是 insertAdjacentHTML / outerHTML —— 后两个在 SVG 元素上的实现
     各家差异更大,而 `svg.innerHTML = buildSVG(...)` 这条路径这个项目
     已经在 iOS 上跑了一年,是已知可靠的。 */
  function svgFrag(html) {
    const box = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    box.innerHTML = html;
    return box.firstElementChild;
  }

  function putEl(parent, old, html) {
    const el = svgFrag(html);
    if (!el) return null;
    if (old) old.parentNode.replaceChild(el, old);
    else parent.appendChild(el);
    return el;
  }

  function upsertEdge(a, b, agg) {
    if (!data || !index || !svg) return false;
    const k = GraphRender.pairKey(a, b);
    const lo = k[0], hi = k[1];
    if (!pos.has(lo) || !pos.has(hi)) return false;   // 有新人 → 必须重排
    // 聚合完权重是 0 且不是混合关系 —— 服务端会整条丢掉,这里也得丢
    if (!agg || !agg.visible) return removeEdge(lo, hi);

    // 端点取 ox/oy(算法排好的原位)而不是 pos.x/y:后者可能正被手指拖着,
    // 松手会飘回原位,存进 payload 的必须是原位那一份。
    const e = GraphRender.edgeFromPair(lo, hi, agg,
      id => { const p = pos.get(id); return { x: p.ox, y: p.oy }; },
      GraphRender.curveCap(data));

    const group = svg.querySelector(".edges");
    if (!group) return false;
    const i = data.edges.findIndex(x => x.a === lo && x.b === hi);
    /* 原地替换 / 追加到末尾 —— 两条路径都保住了
       "第 i 个 .eg 元素 == payload.edges[i]" 这条 buildIndex 依赖的不变量。
       破坏它的话边会接到别的节点身上,而且只在悬停/拖动时才现形。 */
    const el = putEl(group, edgeEl(lo, hi),
                     GraphRender.edgeMarkup(e, rstyle, ""));
    // 没真的插进 DOM 就绝不能动 data.edges —— 一动索引就错位了,
    // 而错位之后每条边都接在别人身上,比不打这个补丁糟得多
    if (!el) return false;
    if (i >= 0) data.edges[i] = e;
    else data.edges.push(e);

    // rstyle 而不是 style:整图渲染时若因边太多关掉了流光,补出来的这条
    // 也必须跟着关,否则它会去引一个 defs 里根本没有的渐变
    if (rstyle.streak) {
      const defs = svg.querySelector("defs");
      // 渐变 id 对不上的话 stroke="url(#e1_2)" 会引到一个不存在的东西:
      // 线整条不可见,而且不报任何错
      if (defs) putEl(defs, svg.querySelector(`#e${lo}_${hi}`),
                      GraphRender.streakDef(e, ""));
    }

    buildIndex(data, true);
    bindEdge(el);                   // 换上去的是新元素,监听得重新挂
    refreshEdgesOf(lo);             // 端点若正被拖着,路径得跟到当前位置
    refreshEdgesOf(hi);
    return true;
  }

  function removeEdge(a, b) {
    if (!data || !index || !svg) return false;
    const k = GraphRender.pairKey(a, b);
    const lo = k[0], hi = k[1];
    if (!pos.has(lo) || !pos.has(hi)) return false;
    const g = edgeEl(lo, hi);
    if (g) g.remove();
    const grad = svg.querySelector(`#e${lo}_${hi}`);
    if (grad) grad.remove();
    const i = data.edges.findIndex(x => x.a === lo && x.b === hi);
    if (i >= 0) data.edges.splice(i, 1);
    buildIndex(data, true);
    return true;
  }

  /* ---------------- 选中态 ---------------- */

  function focus(pid) {
    // 卡片开着的时候关掉悬停高亮,免得两套状态打架
    hoverLocked = pid != null;
    clearHover();
    if (pid == null) {
      svg.classList.remove("focused");
      svg.querySelectorAll(".near,.sel").forEach(el =>
        el.classList.remove("near", "sel"));
      return;
    }
    const near = new Set([pid]);
    svg.querySelectorAll(".eg").forEach(g => {
      const a = +g.dataset.a, b = +g.dataset.b;
      const hit = a === pid || b === pid;
      g.classList.toggle("near", hit);
      if (hit) { near.add(a); near.add(b); }
    });
    svg.querySelectorAll(".node").forEach(g => {
      const id = +g.dataset.id;
      g.classList.toggle("near", near.has(id));
      g.classList.toggle("sel", id === pid);
    });
    svg.classList.add("focused");
  }

  function focusEdge(a, b) {
    hoverLocked = true;
    clearHover();
    svg.querySelectorAll(".near,.sel").forEach(el =>
      el.classList.remove("near", "sel"));
    svg.querySelectorAll(".eg").forEach(g => {
      g.classList.toggle("near",
        (+g.dataset.a === a && +g.dataset.b === b) ||
        (+g.dataset.a === b && +g.dataset.b === a));
    });
    svg.querySelectorAll(".node").forEach(g => {
      const id = +g.dataset.id;
      g.classList.toggle("near", id === a || id === b);
    });
    svg.classList.add("focused");
  }

  /* ---------------- 视口 ---------------- */

  function fit(bottomInset) {
    if (!data || !data.nodes.length) return;
    const r = stage.getBoundingClientRect();
    const f = GraphRender.computeFit(data.nodes, {
      stageW: r.width, stageH: r.height,
      bottomInset: bottomInset || 0, nameSize: rstyle.nameSize,
    });
    scale = f.scale; tx = f.tx; ty = f.ty;
    apply();
    settle();
  }

  function centerOn(pid, bottomInset) {
    if (!data) return;
    const n = data.nodes.find(x => x.id === pid);
    if (!n) return;
    const r = stage.getBoundingClientRect();
    const availH = Math.max(120, r.height - (bottomInset || 0));
    scale = Math.max(scale, 0.9);
    tx = r.width / 2 - n.x * scale;
    ty = availH / 2 - n.y * scale;
    apply();
  }

  /* ---------------- 手势 ---------------- */

  function bindGestures() {
    let mode = null, moved = false;
    let sx = 0, sy = 0, stx = 0, sty = 0;
    let sdist = 0, sscale = 1, pivot = null;
    const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

    /* iOS Safari 从 iOS 10 起就**忽略** <meta viewport> 里的 user-scalable=no
       和 maximum-scale(为了辅助功能)。双指捏合时它同时派发 touch 事件
       (下面这些handler 处理了)和 Safari 私有的 gesture 事件(没人拦)——
       于是我们缩放了图,Safari 又把**整个页面**缩放了一遍。
       真机表现:顶栏的圈子名被挤出屏幕、图例/输入栏/底栏全不见,
       图看起来"卡住"了,而且退不回去。

       touch-action:none 管不到 gesture 事件,唯一可靠的拦法就是
       preventDefault 掉它们。只在 #stage 上拦 —— 设置页那些小字
       还是该让人能放大看的。 */
    for (const t of ["gesturestart", "gesturechange", "gestureend"]) {
      stage.addEventListener(t, e => e.preventDefault(), { passive: false });
    }
    /* 双击缩放同理:iOS 上双击会放大页面,而在图上双击是很自然的动作
       (想放大看某个人)。touch-action:manipulation 就是专门关这个的,
       但 #stage 已经是 none(更严格),这里只补上 dblclick 的兜底。 */
    stage.addEventListener("dblclick", e => e.preventDefault());

    stage.addEventListener("touchstart", e => {
      if (e.touches.length === 1) {
        mode = "pan"; moved = false;
        sx = e.touches[0].clientX; sy = e.touches[0].clientY;
        stx = tx; sty = ty;
      } else if (e.touches.length === 2) {
        mode = "pinch"; moved = true;
        sdist = dist(e.touches[0], e.touches[1]) || 1;
        sscale = scale;
        const r = stage.getBoundingClientRect();
        pivot = {
          x: (e.touches[0].clientX + e.touches[1].clientX) / 2 - r.left,
          y: (e.touches[0].clientY + e.touches[1].clientY) / 2 - r.top,
        };
        stx = tx; sty = ty;
      }
    }, { passive: true });

    stage.addEventListener("touchmove", e => {
      // 正在拖球 —— 这一指属于那个球,画布不要跟着跑
      if (dragId != null) { e.preventDefault(); return; }
      if (mode === "pan" && e.touches.length === 1) {
        const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        tx = stx + dx; ty = sty + dy;
        apply();
      } else if (mode === "pinch" && e.touches.length === 2) {
        const ns = Math.max(0.12, Math.min(6,
          sscale * (dist(e.touches[0], e.touches[1]) / sdist)));
        tx = pivot.x - (pivot.x - stx) * (ns / sscale);
        ty = pivot.y - (pivot.y - sty) * (ns / sscale);
        scale = ns;
        apply();
      }
      e.preventDefault();
    }, { passive: false });

    stage.addEventListener("touchend", e => {
      if (e.touches.length === 0) {
        if (mode === "pan" && !moved && !justDragged && dragId == null
            && cb.onBlank) cb.onBlank();
        mode = null;
      }
    });

    let dragging = false;
    stage.addEventListener("mousedown", e => {
      dragging = true; moved = false;
      sx = e.clientX; sy = e.clientY; stx = tx; sty = ty;
    });
    window.addEventListener("mousemove", e => {
      if (!dragging) return;
      const dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      tx = stx + dx; ty = sty + dy;
      apply();
    });
    window.addEventListener("mouseup", () => {
      if (dragging && !moved && cb.onBlank) cb.onBlank();
      dragging = false;
    });
    stage.addEventListener("wheel", e => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const ns = Math.max(0.12, Math.min(6,
        scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      tx = px - (px - tx) * (ns / scale);
      ty = py - (py - ty) * (ns / scale);
      scale = ns;
      apply();
    }, { passive: false });
  }

  /* 派系着色开关。渐变填充没法靠 CSS 类切换(fill="url(#id)" 写死在属性上),
     所以这里一次性把每个球的 fill 换掉 —— 只在点开关时跑一遍,O(节点数)。 */
  function setFactionMode(on) {
    svg.classList.toggle("by-faction", !!on);
    svg.querySelectorAll(".node").forEach(g => {
      const isMe = g.classList.contains("me");
      const ball = g.querySelector(".ball");
      const glow = g.querySelector(".glow");
      if (isMe) return;                       // 「我」永远用强调色
      if (on) {
        ball.setAttribute("fill", `url(#${ball.dataset.fac})`);
        glow.setAttribute("fill", `url(#${glow.dataset.fac})`);
      } else {
        ball.setAttribute("fill", "url(#sph_sph)");
        glow.setAttribute("fill", "url(#glow_sph)");
      }
    });
  }

  function nodeColor(id) {
    // 走 buildIndex 建好的 byId,不再线性 find —— 这个函数是人物页
    // 每一行的头像色的来源,一次搜索会调上百次
    const n = byId ? byId.get(id) : null;
    if (!n) return "var(--sph)";
    if (n.is_me) return "var(--me)";
    if (svg.classList.contains("by-faction"))
      return n.frank < 3 ? `var(--f${n.frank + 1})` : "var(--f1)";
    return "var(--sph)";
  }

  return { init, render, fit, focus, focusEdge, centerOn, nodeColor,
           setFactionMode, setStyle, resetPositions, upsertEdge, removeEdge };
})();


/* ============================================================
   纯渲染:payload + 样式 → SVG 字符串
   ============================================================ */

const GraphRender = (() => {

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  // 中文字符的宽度约等于字号的 0.58 倍(含一点安全余量)
  const CHAR_W = 0.58;
  const LABEL_GAP = 6;        // 名字与球之间的间隙(屏幕像素)
  const PAD = 16;             // 画布四周的内边距(屏幕像素)

  // 与服务端 layout._arc 同一套数学 —— 拖动时前端要自己重算弧线
  const CURVE = 0.10, CURVE_CAP_RATIO = 0.034;

  function labelHalfPx(name, nameSize) {
    return String(name || "").length * nameSize * CHAR_W / 2;
  }

  /* ---------------- LOD:名字要显示到什么程度 ----------------

     阈值**不能写死成 `scale > 0.6` 这种数**。画布尺寸随 √人数变化
     (layout.canvas_of:k = √(人数/20),钳在 0.55~2.6),所以复位后的 scale
     跟人数强相关 —— 实测同一台 iPhone(390×844)上,19 人复位到 0.636,
     100 人复位到 0.259。写死 0.6 的话:19 人永远全开(哪怕捏到很小),
     100 人永远不开(哪怕放大到看得清)。两边都错。

     能拿来比的是这两个量:
       · 屏幕上的节点间距 = NN_FACTOR × √(画布面积 / 人数) × scale
         ← 前半截是画布单位,乘 scale 才变成屏幕像素
       · 最长名字的宽度   = 字数 × nameSize × CHAR_W
         ← **恒定屏幕像素**,不随缩放变
     这正是 computeFit 赖以成立的那个二分(球是画布单位、名字是屏幕像素)。
     把两者混起来就是上一版栽的那个跟头 —— 别再混。

     NN_FACTOR:√(面积/人数) 是"每人一格"的格距,而真实的最近邻距离比它小,
     因为力导向布局会成团。实测平均最近邻 / 格距:
       紧凑化之后  19 人 133/177 = 0.75、100 人 127/177 = 0.72、199/260 = 0.77
       紧凑化之前  19 人竖屏 0.58、宽屏 0.65
     取 0.70(两代布局的中位),偏保守的一侧。fittest.js 里对真实坐标核了
     这个系数落在 0.5~0.9 之间 —— 布局哪天散开或塌成一团,那条会先响。

     比值 ≥1 → 相邻两个名字互不相撞,全开。
     只留 key 时节点数降到 KEY_SHARE(layout.py 的 keep = round(人数 × 0.3)),
     间距放大 1/√0.3 ≈ 1.83 倍,所以比值 ≥ √0.3 ≈ 0.55 就够。
     **这个数是推出来的**;哪天 layout.py 改了那个 0.3,改这里一个常量即可。
     (layout 还会额外把"我"和度数≥5 的人也标成 key,所以实际比例只会更高 ——
     误差落在"名字留多了"这一侧,不会突然全没。)

     解决拥挤的正解是**减少名字的数量**,不是把名字改小:
     --gscale 的反向补偿曲线一动,computeFit 的贴合立刻跟着塌。 */
  const LOD_NN_FACTOR = 0.70;
  const LOD_KEY_SHARE = 0.30;
  const LOD_T_ALL = 1.0;
  const LOD_T_KEY = Math.sqrt(LOD_KEY_SHARE);
  const LOD_HYST = 0.08;

  function lodRatio(payload, scale, nameSize) {
    const nodes = (payload && payload.nodes) || [];
    if (!nodes.length) return Infinity;
    let longest = 1;
    for (const n of nodes) {
      const len = String(n.name || "").length;
      if (len > longest) longest = len;
    }
    const spacing = LOD_NN_FACTOR * scale * Math.sqrt(
      (payload.width * payload.height) / nodes.length);
    return spacing / (longest * nameSize * CHAR_W);
  }

  /* ±8% 迟滞。不加的话,捏合到阈值附近手指一抖,几十个名字就会成片地
     开、关、开 —— 比一直不显示还难受。往"显示得更多"走要越过上沿,
     往回退要跌破下沿,中间这 16% 是死区。 */
  function lodLevel(ratio, prev) {
    const up = 1 + LOD_HYST, dn = 1 - LOD_HYST;
    const allT = LOD_T_ALL * (prev === "all" ? dn : up);
    const keyT = LOD_T_KEY * (prev === "none" ? up : dn);
    if (ratio >= allT) return "all";
    if (ratio >= keyT) return "key";
    return "none";
  }

  /* 星点数量封顶。数量按画布面积算(stars × 面积 / 130 万),而画布随 √人数
     变大:100 人的竖屏画布到 6.75M px²,A 档会生成 778 个 <circle> ——
     全是纯装饰,一个都点不着。260 个在最大画布上仍有 38 颗/百万 px²,
     肉眼分辨不出少了。 */
  const STAR_CAP = 260;

  /* 流光渐变按边数降级。100 人 ≈ 381 条边,每条一个 <linearGradient> + 4~6 个
     <stop> = 约 1905 个 DOM 节点,而那个尺度上每条线在屏幕上只有几十像素长,
     "两端淡出"根本看不见 —— 为一个看不见的效果付了全场最大的一笔 DOM 开销。

     **不要改成共享渐变**:流光靠 gradientUnits="userSpaceOnUse" + 每条边自己的
     端点坐标,换成 objectBoundingBox 之后竖直边的包围盒宽度≈0,渐变会退化成
     纯色。这不是懒得做,是数学上做不到。 */
  const STREAK_MAX_EDGES = 160;

  function effectiveStyle(st, payload) {
    const style = st || GraphStyles.A;
    const n = payload && payload.edges ? payload.edges.length : 0;
    if (!style.streak || n <= STREAK_MAX_EDGES) return style;
    // 复制一份,绝不改 GraphStyles.A 本身 —— 那是全局共享的常量
    return Object.assign({}, style, { streak: false });
  }

  /* 计算贴合视口的变换。**纯函数,不碰 DOM**,所以能在 node 里自动验证。
   *
   * 关键在于把两个坐标系分开:
   *   节点位置是画布坐标,会随缩放变;
   *   名字是恒定的屏幕尺寸(字号写死 px 再除以缩放),不随缩放变。
   *
   * 之前把二者混为一谈 —— 用 12.5px 当画布单位去估名字宽度,
   * 而复位后缩放约 0.45,名字在画布里的实际宽度是估算值的两倍多,
   * 于是越靠边的名字裁得越狠。
   *
   * 正确做法:先从视口里扣掉固定的屏幕像素余量,再用剩下的空间算缩放。
   * 不循环依赖,一次算准。
   */
  function computeFit(nodes, o) {
    const minScale = o.minScale == null ? 0.2 : o.minScale;
    const maxScale = o.maxScale == null ? 1.3 : o.maxScale;
    if (!nodes || !nodes.length) return { scale: 1, tx: 0, ty: 0 };

    // 1. 纯节点包围盒(画布坐标)
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    let halfLabel = 0;
    for (const n of nodes) {
      minX = Math.min(minX, n.x - n.r); maxX = Math.max(maxX, n.x + n.r);
      minY = Math.min(minY, n.y - n.r); maxY = Math.max(maxY, n.y + n.r);
      halfLabel = Math.max(halfLabel, labelHalfPx(n.name, o.nameSize));
    }
    const nw = Math.max(1, maxX - minX), nh = Math.max(1, maxY - minY);

    // 2. 从视口里扣掉固定的屏幕像素余量。
    //    取全局最宽的名字是保守估计 —— 略微浪费一点空间,但保证任何数据都不裁。
    const belowPx = o.nameSize + LABEL_GAP + 4;   // 名字在球下方
    const availW = Math.max(40, o.stageW - 2 * (halfLabel + PAD));
    const availH = Math.max(40, o.stageH - (o.bottomInset || 0) - belowPx - PAD * 2);

    // 3. 用剩下的可用区算缩放,再把节点包围盒居中放进去
    const scale = Math.max(minScale,
      Math.min(maxScale, Math.min(availW / nw, availH / nh)));
    const tx = PAD + halfLabel + (availW - nw * scale) / 2 - minX * scale;
    const ty = PAD + (availH - nh * scale) / 2 - minY * scale;
    return { scale, tx, ty };
  }

  /* 一条弧线的控制点与曲线中点。拖动时端点变了,这些都要跟着重算。 */
  /* bend 是服务端算好的弯曲系数(默认 1,为了绕开挡路的节点会加大或翻转)。
     拖动时必须用**同一个系数**重算,否则一拖这条边就跳回默认弧度,
     又穿回别人的球心上去。 */
  function arc(x1, y1, x2, y2, cap, bend) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const off = Math.min(CURVE * len, cap) * (bend == null ? 1 : bend);
    const cx = mx + (-dy / len) * off, cy = my + (dx / len) * off;
    return { cx, cy,
             qx: 0.25 * x1 + 0.5 * cx + 0.25 * x2,
             qy: 0.25 * y1 + 0.5 * cy + 0.25 * y2 };
  }

  function curveCap(payload) {
    return CURVE_CAP_RATIO * Math.hypot(payload.width, payload.height);
  }

  /* 固定种子的伪随机 —— 星点每次都在同一个位置,不会闪来闪去 */
  function rng(seed) {
    let s = seed >>> 0;
    return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
  }

  function stars(w, h, count) {
    if (!count) return "";
    const r = rng(20260126);
    const out = ['<g class="stars">'];
    for (let i = 0; i < count; i++) {
      out.push(`<circle cx="${(r() * w).toFixed(1)}" cy="${(r() * h).toFixed(1)}" ` +
               `r="${(0.6 + r() * 1.5).toFixed(2)}" ` +
               `opacity="${(0.15 + r() * 0.6).toFixed(2)}"/>`);
    }
    out.push("</g>");
    return out.join("");
  }

  /* 球体的三段渐变。中心偏到左上,才有体积感。 */
  function sphereDef(id, v) {
    return `<radialGradient id="${id}" cx="34%" cy="28%" r="76%">` +
           `<stop offset="0%"   stop-color="var(${v}-lt)"/>` +
           `<stop offset="52%"  stop-color="var(${v})"/>` +
           `<stop offset="100%" stop-color="var(${v}-dk)"/></radialGradient>`;
  }

  function glowDef(id, v, op) {
    return `<radialGradient id="${id}">` +
           `<stop offset="33%" stop-color="var(${v})" stop-opacity="${op}"/>` +
           `<stop offset="68%" stop-color="var(${v})" stop-opacity="${(op * 0.3).toFixed(3)}"/>` +
           `<stop offset="100%" stop-color="var(${v})" stop-opacity="0"/></radialGradient>`;
  }

  const PALETTES = [["sph", "--sph"], ["me", "--me"],
                    ["f1", "--f1"], ["f2", "--f2"], ["f3", "--f3"]];

  /* 一条边的流光渐变。**只有这一处**生成它 —— buildSVG 全量渲染和
     GraphView.upsertEdge 增量补丁走的是同一个函数,所以不可能画得不一样。 */
  function streakDef(e, idPrefix) {
    const P = idPrefix || "";
    const head = `<linearGradient id="${P}e${e.a}_${e.b}" ` +
      `gradientUnits="userSpaceOnUse" ` +
      `x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}">`;
    /* 混合关系(既是朋友又是对手)画成一头青一头红 —— 一眼就能看出
       "这两个人关系很复杂"。这是图上信息量最大的一种边:结构洞所在。
       正好复用已有的流光渐变机制,零额外成本、不用 filter。 */
    if (e.mixed) {
      return head +
        /* 中间是**渐变过渡**,不是硬切换。硬切换踩过一次真实事故:
           一条 Luna→X 的混合边正好从 Alex 的球心穿过去(离球心 1.7px),
           而换色点落在 47% —— 画面上读起来成了"Luna 连 Alex(青),
           Alex 连 X(红)",一条边被看成两条,还连错了人。
           穿心那件事由服务端的避让算法治(layout._clear_bend),
           这里再补一道:没有硬边界,就不会有"两条线在此交汇"的错觉。 */
        `<stop offset="0%"   stop-color="var(--pos)" stop-opacity="0.10"/>` +
        `<stop offset="22%"  stop-color="var(--pos)" stop-opacity="1"/>` +
        `<stop offset="38%"  stop-color="var(--pos)" stop-opacity="0.95"/>` +
        `<stop offset="62%"  stop-color="var(--neg)" stop-opacity="0.95"/>` +
        `<stop offset="78%"  stop-color="var(--neg)" stop-opacity="1"/>` +
        `<stop offset="100%" stop-color="var(--neg)" stop-opacity="0.10"/>` +
        `</linearGradient>`;
    }
    const v = e.w < 0 ? "--neg" : "--pos";
    return head +
      `<stop offset="0%"   stop-color="var(${v})" stop-opacity="0.06"/>` +
      `<stop offset="30%"  stop-color="var(${v})" stop-opacity="1"/>` +
      `<stop offset="70%"  stop-color="var(${v})" stop-opacity="1"/>` +
      `<stop offset="100%" stop-color="var(${v})" stop-opacity="0.06"/>` +
      `</linearGradient>`;
  }

  /* 一条边的可见部分(路径 + 命中区 + 标签)。理由同上:全项目一份。 */
  function edgeMarkup(e, st, idPrefix) {
    const style = st || GraphStyles.A;
    const P = idPrefix || "";
    const mix = !!e.mixed;
    const neg = !mix && e.w < 0;
    const d = `M${e.x1},${e.y1} Q${e.cx},${e.cy} ${e.x2},${e.y2}`;
    const solid = neg ? "--neg" : "--pos";
    // 混合边的双色只存在于渐变里,所以它无视 streak 降级 —— 见 buildSVG 的 else 分支
    const stroke = (style.streak || mix)
      ? `url(#${P}e${e.a}_${e.b})` : `var(${solid})`;
    // 混合边和负向边一样要压过正向边的视觉权重 —— 它们是"值得看的地方"
    const op = (neg || mix) ? Math.min(1, style.edgeOp * 1.4) : style.edgeOp;
    const cls = mix ? "mix" : (neg ? "neg" : "pos");
    return `<g class="eg ${cls}" data-a="${e.a}" data-b="${e.b}">` +
      `<path class="edge" d="${d}" stroke="${stroke}" ` +
        `stroke-width="${(e.width * style.edgeW).toFixed(2)}" ` +
        `opacity="${op.toFixed(2)}"${neg ? ' stroke-dasharray="7 6"' : ""}/>` +
      `<path class="edge-hit" d="${d}"/>` +
      `<text class="elabel" x="${e.mx}" y="${e.my - 11}">` +
        `${esc(e.glyph)} ${esc(e.label)}` +
        (e.count > 1 ? ` +${e.count - 1}` : "") + `</text>` +
      `</g>`;
  }

  /* ---------------- 增量补丁要用的纯计算 ----------------

     下面这三个函数是 **analysis.build_graph + layout._edge_display 的逐字复刻**。
     手动录完一条关系后前端要自己算出那条边长什么样,不能再去问服务端
     (/api/graph 是个会写库的 GET,和用户的 POST 并发会串事务)。

     复刻必须逐字,差一点就会出现"图上这条线和刷新后不一样"这种最难查的 bug。
     所以 fittest.js 里用 python 跑真实管线导出了期望值逐条对。
     尤其注意:**Python 的 max 平局取第一个,所以下面一律写 > 不能写 >=**。 */

  // 键归一成 (min, max) —— 服务端的 pair_kinds 就是这么建的
  function pairKey(a, b) {
    return a <= b ? [a, b] : [b, a];
  }

  function pairAggregate(rels, glyphMap) {
    const gm = glyphMap || {};
    const list = rels || [];
    let w = 0, pw = 0, nw = 0;
    for (const r of list) {
      const s = +r.strength || 0;
      w += s;
      if (s > 0) pw += s;
      else if (s < 0) nw += s;
    }
    // 先求和再钳,和服务端同序 —— 反过来的话 (+3,+3) 会得到 +3 而不是 +3 的钳值
    w = Math.max(-3, Math.min(3, w));
    pw = Math.min(3, pw);
    nw = Math.max(-3, nw);

    // 正负分量都非零 = 混合关系。这类边**即便合并权重是 0 也必须存在**,
    // 「私交极好但工作上是对手」正是最该被看见的一种关系。
    const mixed = pw > 0 && nw < 0;
    const mag = Math.max(Math.abs(w), Math.abs(pw), Math.abs(nw));
    const base = {
      w, pw, nw, mixed,
      count: list.length,
      all_kinds: list.map(r => r.kind),
      // 服务端:round(0.8 + 0.47 * mag, 2)
      width: Math.round((0.8 + 0.47 * mag) * 100) / 100,
      visible: list.length > 0 && (w !== 0 || mixed),
    };

    let dom = null, best = -1;
    for (const r of list) {
      const m = Math.abs(+r.strength || 0);
      if (m > best) { best = m; dom = r; }      // > 不是 >=:平局取第一个
    }
    const cat = (dom && dom.cat) || "社交";

    if (mixed) {
      // 混合边的标签要同时点出两面,只显示"最强的那个"会误导 ——
      // 强度相同时(朋友+2 / 竞争-2)取哪个纯属偶然
      let pk = null, nk = null;
      for (const r of list) {
        const s = +r.strength || 0;
        if (s > 0 && (!pk || s > (+pk.strength || 0))) pk = r;
        if (s < 0 && (!nk || s < (+nk.strength || 0))) nk = r;
      }
      if (pk && nk) {
        return Object.assign(base, {
          label: `${pk.kind} / ${nk.kind}`, cat, glyph: "⚡",
        });
      }
    }
    return Object.assign(base, {
      label: dom ? dom.kind : "", cat, glyph: gm[cat] || "",
    });
  }

  // 服务端坐标都 round 到 1 位小数,这里跟着走,免得同一条边刷新前后差 0.03
  const r1 = v => Math.round(v * 10) / 10;

  /* 聚合结果 + 两个端点的位置 → 一条和服务端 payload 同构的边对象。
     纯函数(位置靠 getPos 回调传进来),所以能在 node 里断言。 */
  function edgeFromPair(a, b, agg, getPos, cap) {
    const k = pairKey(a, b);
    const A = getPos(k[0]), B = getPos(k[1]);
    const q = arc(A.x, A.y, B.x, B.y, cap);
    return {
      a: k[0], b: k[1],
      x1: r1(A.x), y1: r1(A.y), x2: r1(B.x), y2: r1(B.y),
      cx: r1(q.cx), cy: r1(q.cy),
      mx: r1(q.qx), my: r1(q.qy),
      w: agg.w, pw: agg.pw, nw: agg.nw, width: agg.width,
      label: agg.label, cat: agg.cat, glyph: agg.glyph,
      count: agg.count, all_kinds: agg.all_kinds, mixed: agg.mixed,
    };
  }

  function buildSVG(payload, st, idPrefix) {
    // 降级判定放在这里,GraphView.render 也调同一个函数存进 rstyle ——
    // 两边必须得出同一个答案,否则增量补丁会引到不存在的渐变
    const style = effectiveStyle(st, payload);
    const P = idPrefix || "";              // 一个页面渲染多份时用来隔离 id
    const W = payload.width, H = payload.height;
    const dens = payload.density || 1;     // 人越多,光晕越收,免得糊成一片
    const glowOp = (style.glowOp * (0.55 + 0.45 * dens)).toFixed(3);
    const out = [];

    out.push("<defs>");
    for (const [id, v] of PALETTES) {
      out.push(sphereDef(`${P}sph_${id}`, v));
      out.push(glowDef(`${P}glow_${id}`, v, glowOp));
    }
    if (style.streak) {
      // 流光连线:两端淡出、中间实 —— 线就有了光带的收束感
      for (const e of payload.edges) out.push(streakDef(e, P));
    } else {
      /* 流光被边数降级关掉了,但**混合边必须保留自己的渐变** ——
         它那"一头青一头红"就是靠渐变画的,退回纯色后会变成一条纯红实线,
         和负向边只差没有虚线,而图例还在承诺双色。
         而且这恰恰发生在最需要区分的规模上(边多 = 人多 = 更需要看清谁跟谁
         关系复杂)。混合边本来就稀少,为它们保留 per-edge 渐变的开销可以忽略。 */
      for (const e of payload.edges) if (e.mixed) out.push(streakDef(e, P));
    }
    out.push("</defs>");

    // 星点压在最底层。封顶见 STAR_CAP —— 不封的话 100 人会画 778 个圆
    out.push(stars(W, H,
      Math.min(STAR_CAP, Math.round(style.stars * (W * H) / 1300000))));

    out.push('<g class="edges">');
    for (const e of payload.edges) out.push(edgeMarkup(e, style, P));
    out.push("</g>");

    out.push('<g class="nodes">');
    for (const n of payload.nodes) {
      const r = n.r * style.ball;
      const pal = n.is_me ? "me" : "sph";
      const fac = n.frank < 3 ? "f" + (n.frank + 1) : "f1";
      /* n.key 是 layout.py 早就算好的"这个人重要到名字该常显"(前端以前
         0 处引用)。它只落成一个 class,显不显示由 #svg 上的 .lod-* 决定 ——
         JS 一次都不用去遍历这些节点。 */
      out.push(
        `<g class="node ${n.is_me ? "me " : ""}${n.key ? "key " : ""}` +
        `fac-${fac}" data-id="${n.id}">` +
        `<circle class="glow" cx="${n.x}" cy="${n.y}" ` +
          `r="${(r * style.glow).toFixed(1)}" fill="url(#${P}glow_${pal})" ` +
          `data-fac="${P}glow_${fac}"/>` +
        `<circle class="ball" cx="${n.x}" cy="${n.y}" r="${r.toFixed(1)}" ` +
          `fill="url(#${P}sph_${pal})" data-fac="${P}sph_${fac}"/>` +
        `<circle class="rim" cx="${n.x}" cy="${n.y}" r="${r.toFixed(1)}"/>` +
        `<ellipse class="spec" cx="${(n.x - r * 0.30).toFixed(1)}" ` +
          `cy="${(n.y - r * 0.36).toFixed(1)}" ` +
          `rx="${(r * 0.36).toFixed(1)}" ry="${(r * 0.23).toFixed(1)}"/>` +
        `<text class="ini" x="${n.x}" y="${n.y}" ` +
          `style="font-size:${(r * 0.7).toFixed(1)}px">${esc(n.initial)}</text>` +
        // 名字:字号和垂直偏移都要按缩放反向补偿。
        // 只补字号不补偏移的后果:缩小后字变大、偏移没变,名字压在球上。
        `<text class="nm" x="${n.x}" y="${(n.y + r + 4).toFixed(1)}" ` +
          `style="font-size:calc(${style.nameSize}px / var(--gscale,1));` +
          `transform:translateY(calc(${style.nameSize}px / var(--gscale,1)))">` +
          `${esc(n.name)}</text></g>`);
    }
    out.push("</g>");

    return out.join("");
  }

  return { buildSVG, esc, computeFit, arc, curveCap, labelHalfPx,
           edgeMarkup, streakDef, pairAggregate, pairKey, edgeFromPair,
           lodRatio, lodLevel, effectiveStyle,
           STAR_CAP, STREAK_MAX_EDGES, LOD_NN_FACTOR, LOD_HYST };
})();
