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

const GraphStyles = {
  // 三档强度,方向相同(都照参考图),只在浓淡上不同
  A: { name: "A · 忠于参考图", ball: 1.15, glow: 2.9, glowOp: 0.62,
       edgeW: 1.5, edgeOp: 0.60, stars: 150, nameSize: 13.5, streak: true },
  B: { name: "B · 中间", ball: 1.0, glow: 2.3, glowOp: 0.45,
       edgeW: 1.15, edgeOp: 0.50, stars: 90, nameSize: 12.5, streak: true },
  C: { name: "C · 收敛", ball: 0.85, glow: 1.7, glowOp: 0.28,
       edgeW: 0.9, edgeOp: 0.42, stars: 40, nameSize: 11.5, streak: false },
};

const GraphView = (() => {
  let stage, canvas, svg;
  let data = null;
  let tx = 0, ty = 0, scale = 1;
  let cb = {};
  let settleTimer = null;
  let style = GraphStyles.B;

  // 邻接索引与当前位置(见 buildIndex)
  let index = null, pos = null;
  let hovered = null, hoverLocked = false;
  let dragId = null, justDragged = false, longPress = null;
  let pendingMove = null, rafId = 0;

  const LONG_PRESS_MS = 500;      // 手机上长按多久才进入拖动(用户选的)
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

  function setStyle(s) { style = s || GraphStyles.B; }

  function apply() {
    canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 90);
  }

  /* 缩放稳定后再补偿字号:手势进行中让文字跟着缩放是自然的,松手后归位。
     绝不在每一帧改字号 —— 那会让几十个文本节点反复重排,直接发热。
     这里只写一个 CSS 变量,是 O(1) 的。 */
  function settle() {
    svg.style.setProperty("--gscale", scale.toFixed(3));
  }

  function render(payload) {
    data = payload;
    svg.setAttribute("viewBox", `0 0 ${payload.width} ${payload.height}`);
    svg.setAttribute("width", payload.width);
    svg.setAttribute("height", payload.height);
    svg.innerHTML = GraphRender.buildSVG(payload, style);
    buildIndex(payload);

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
    svg.querySelectorAll(".eg .edge-hit").forEach(p => {
      p.addEventListener("click", ev => {
        ev.stopPropagation();
        if (cb.onEdge) cb.onEdge(+p.parentNode.dataset.a, +p.parentNode.dataset.b);
      });
    });
  }

  /* ---------------- 邻接索引 ----------------
     悬停是**每动一下鼠标就触发**的,不能像点击那样每次全量 querySelectorAll。
     渲染后建一张 `节点 id → {它的边元素, 邻居 id}` 的表,
     悬停和拖动就都只碰 O(度数) 个元素,与总节点数无关。 */

  function buildIndex(payload) {
    index = new Map();
    pos = new Map();
    hovered = null;
    for (const n of payload.nodes) {
      pos.set(n.id, { x: n.x, y: n.y, ox: n.x, oy: n.y });
    }
    const byId = new Map(payload.nodes.map(n => [n.id, n]));
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

     拖动结果**不落库**,刷新即回到算法排好的位置 —— 所以后端一行不用改。 */

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
      const a = GraphRender.arc(A.x, A.y, B.x, B.y, cap);
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
    if (it) it.g.classList.add("dragging");
    svg.classList.add("has-drag");
  }

  function endDrag() {
    if (dragId == null) return;
    const it = index.get(dragId);
    if (it) it.g.classList.remove("dragging");
    svg.classList.remove("has-drag");
    dragId = null;
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

  /* 复位按钮顺带把拖过的球放回算法排的位置 —— 反正拖动本来就不持久化,
     "复位"理应恢复原状。返回值告诉调用方要不要提示一句。 */
  function resetPositions() {
    if (!index || !pos || !data) return false;
    let moved = false;
    for (const [id, p] of pos) {
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
      bottomInset: bottomInset || 0, nameSize: style.nameSize,
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
    if (!data) return "var(--sph)";
    const n = data.nodes.find(x => x.id === id);
    if (!n) return "var(--sph)";
    if (n.is_me) return "var(--me)";
    if (svg.classList.contains("by-faction"))
      return n.frank < 3 ? `var(--f${n.frank + 1})` : "var(--f1)";
    return "var(--sph)";
  }

  return { init, render, fit, focus, focusEdge, centerOn, nodeColor,
           setFactionMode, setStyle, resetPositions };
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
  function arc(x1, y1, x2, y2, cap) {
    const dx = x2 - x1, dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    const off = Math.min(CURVE * len, cap);
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

  function buildSVG(payload, st, idPrefix) {
    const style = st || GraphStyles.B;
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
      for (const e of payload.edges) {
        const v = e.w < 0 ? "--neg" : "--pos";
        out.push(
          `<linearGradient id="${P}e${e.a}_${e.b}" gradientUnits="userSpaceOnUse" ` +
          `x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}">` +
          `<stop offset="0%"   stop-color="var(${v})" stop-opacity="0.06"/>` +
          `<stop offset="30%"  stop-color="var(${v})" stop-opacity="1"/>` +
          `<stop offset="70%"  stop-color="var(${v})" stop-opacity="1"/>` +
          `<stop offset="100%" stop-color="var(${v})" stop-opacity="0.06"/>` +
          `</linearGradient>`);
      }
    }
    out.push("</defs>");

    // 星点压在最底层
    out.push(stars(W, H, Math.round(style.stars * (W * H) / 1300000)));

    out.push('<g class="edges">');
    for (const e of payload.edges) {
      const neg = e.w < 0;
      const d = `M${e.x1},${e.y1} Q${e.cx},${e.cy} ${e.x2},${e.y2}`;
      const stroke = style.streak
        ? `url(#${P}e${e.a}_${e.b})` : `var(${neg ? "--neg" : "--pos"})`;
      const op = neg ? Math.min(1, style.edgeOp * 1.4) : style.edgeOp;
      out.push(
        `<g class="eg ${neg ? "neg" : "pos"}" data-a="${e.a}" data-b="${e.b}">` +
        `<path class="edge" d="${d}" stroke="${stroke}" ` +
          `stroke-width="${(e.width * style.edgeW).toFixed(2)}" ` +
          `opacity="${op.toFixed(2)}"${neg ? ' stroke-dasharray="7 6"' : ""}/>` +
        `<path class="edge-hit" d="${d}"/>` +
        `<text class="elabel" x="${e.mx}" y="${e.my - 11}">` +
          `${esc(e.glyph)} ${esc(e.label)}` +
          (e.count > 1 ? ` +${e.count - 1}` : "") + `</text>` +
        `</g>`);
    }
    out.push("</g>");

    out.push('<g class="nodes">');
    for (const n of payload.nodes) {
      const r = n.r * style.ball;
      const pal = n.is_me ? "me" : "sph";
      const fac = n.frank < 3 ? "f" + (n.frank + 1) : "f1";
      out.push(
        `<g class="node ${n.is_me ? "me " : ""}fac-${fac}" data-id="${n.id}">` +
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

  return { buildSVG, esc, computeFit, arc, curveCap, labelHalfPx };
})();
