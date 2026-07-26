/* 图谱渲染 —— 手机端只做"画",不做任何计算。
 *
 * 坐标、弧线控制点、标签落点、类别标记符,全部由服务端算好送过来。
 * 这里只把它们拼成 SVG,然后平移缩放只改一个 CSS transform,
 * 由 GPU 合成 —— 没有物理循环、没有逐帧计算,所以手机不发热。
 *
 * 视觉编码(深空极简:画面主体是灰阶,颜色只用在该被看见的地方):
 *   人的重要性 → 节点大小 + 亮度(不是颜色)
 *   「我」      → 唯一的强调色
 *   关系正负   → 正向几乎融进背景,**负向才用暖色**并加虚线
 *                让"矛盾"成为画面上唯一跳出来的东西
 *   关系强度   → 线宽
 *   关系类别   → 中点标记符,放大后才浮现,平时不占画面
 *   派系       → 默认靠**空间聚集**读;顶栏开关切到「派系着色」才上色,
 *                那时才用经过色觉障碍校验的分类色板
 *
 * 发光效果用 SVG 径向渐变画的同心光晕,**不用 filter**。
 * iOS Safari 上 filter/backdrop-filter 极慢,用它做发光会直接把
 * 服务端算布局省下来的功耗全赔进去。
 *
 * 颜色全部走 CSS 自定义属性,所以系统切换深浅色时浏览器直接重新着色,
 * 不需要重建 SVG。
 */

const GraphView = (() => {
  const ZOOM_REVEAL = 0.92;   // 超过这个缩放级别,全部名字和首字浮现

  let stage, canvas, svg;
  let data = null;
  let tx = 0, ty = 0, scale = 1;
  let cb = {};
  let settleTimer = null;

  function init(opts) {
    stage = document.getElementById("stage");
    canvas = document.getElementById("canvas");
    svg = document.getElementById("svg");
    cb = opts || {};
    bindGestures();
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  function apply() {
    canvas.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
    scheduleSettle();
  }

  /* 缩放稳定后再补偿字号。
     手势进行中让文字跟着一起缩放是自然的;松手后统一归位。
     绝不在每一帧改字号 —— 那会让几十个文本节点反复重排,直接发热。
     这里只写一个 CSS 变量,是 O(1) 的。 */
  function scheduleSettle() {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(settle, 90);
  }
  function settle() {
    svg.style.setProperty("--gscale", scale.toFixed(3));
    svg.classList.toggle("zoomed", scale >= ZOOM_REVEAL);
  }

  /* ---------------- 渲染 ---------------- */

  function render(payload) {
    data = payload;
    const W = payload.width, H = payload.height;
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);

    const out = [];

    out.push("<defs>");
    // 光晕:纯径向渐变填充,不是滤镜。只给重要节点和「我」,避免画面糊成一片。
    for (const [id, v] of [["0", "--n-hi"], ["1", "--n-hi"], ["2", "--n-hi"],
                           ["3", "--n-hi"], ["me", "--accent"]]) {
      out.push(
        `<radialGradient id="halo${id}">` +
        `<stop offset="30%" stop-color="var(${v})" stop-opacity="0.5"/>` +
        `<stop offset="100%" stop-color="var(${v})" stop-opacity="0"/>` +
        `</radialGradient>`);
    }
    out.push("</defs>");

    // --- 边(先画,压在节点下面)---
    out.push('<g id="edges">');
    for (const e of payload.edges) {
      const neg = e.w < 0;
      const cls = neg ? "neg" : "pos";
      const d = `M${e.x1},${e.y1} Q${e.cx},${e.cy} ${e.x2},${e.y2}`;
      const dash = neg ? ' stroke-dasharray="8 6"' : "";
      out.push(
        `<g class="eg" data-a="${e.a}" data-b="${e.b}">` +
        `<path class="edge ${cls}" d="${d}" stroke-width="${e.width}"${dash}/>` +
        `<path class="edge-hit" d="${d}"/>` +
        `<text class="eglyph ${cls}" x="${e.mx}" y="${e.my}">${esc(e.glyph)}</text>` +
        `<text class="elabel" x="${e.mx}" y="${e.my - 15}">${esc(e.label)}` +
        (e.count > 1 ? ` +${e.count - 1}` : "") + `</text>` +
        `</g>`);
    }
    out.push("</g>");

    // --- 节点 ---
    // 亮度分三档:重要的人更亮更大,边缘的人沉下去。用亮度而不是颜色做层级,
    // 是"深空极简"最核心的一条 —— 颜色留给真正需要被看见的东西。
    const rs = payload.nodes.map(n => n.r).sort((a, b) => b - a);
    const hiCut = rs[Math.floor(rs.length * 0.22)] ?? 0;
    const midCut = rs[Math.floor(rs.length * 0.62)] ?? 0;

    out.push('<g id="nodes">');
    for (const n of payload.nodes) {
      const slot = n.frank < 3 ? n.frank : 3;      // 派系着色模式才用得上
      const tier = n.r >= hiCut ? "t-hi" : (n.r >= midCut ? "t-mid" : "t-lo");
      const cls = "node " + tier + " f" + (slot === 3 ? "0" : slot + 1) +
                  (n.is_me ? " me" : "") + (n.key ? " key" : "");
      out.push(
        `<g class="${cls}" data-id="${n.id}">` +
        (tier === "t-hi" || n.is_me
          ? `<circle class="halo" cx="${n.x}" cy="${n.y}" ` +
            `r="${(n.r * 3.1).toFixed(1)}" fill="url(#halo${n.is_me ? "me" : slot})"/>`
          : "") +
        (n.is_me
          ? `<circle class="ring" cx="${n.x}" cy="${n.y}" r="${(n.r + 5).toFixed(1)}"/>`
          : "") +
        `<circle class="disc" cx="${n.x}" cy="${n.y}" r="${n.r}"/>` +
        `<text class="ini" x="${n.x}" y="${n.y}">${esc(n.initial)}</text>` +
        `<text class="nm" x="${n.x}" y="${(n.y + n.r + 15).toFixed(1)}">` +
        `${esc(n.name)}</text>` +
        `</g>`);
    }
    out.push("</g>");

    svg.innerHTML = out.join("");

    svg.querySelectorAll(".node").forEach(g => {
      g.addEventListener("click", ev => {
        ev.stopPropagation();
        if (cb.onNode) cb.onNode(+g.dataset.id);
      });
    });
    svg.querySelectorAll(".eg .edge-hit").forEach(p => {
      p.addEventListener("click", ev => {
        ev.stopPropagation();
        const g = p.parentNode;
        if (cb.onEdge) cb.onEdge(+g.dataset.a, +g.dataset.b);
      });
    });
  }

  /* ---------------- 选中态 ---------------- */

  function focus(pid) {
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
      g.querySelectorAll(".edge,.eglyph,.elabel").forEach(el =>
        el.classList.toggle("near", hit));
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
    svg.querySelectorAll(".near,.sel").forEach(el =>
      el.classList.remove("near", "sel"));
    svg.querySelectorAll(".eg").forEach(g => {
      const hit = (+g.dataset.a === a && +g.dataset.b === b) ||
                  (+g.dataset.a === b && +g.dataset.b === a);
      g.querySelectorAll(".edge,.eglyph,.elabel").forEach(el =>
        el.classList.toggle("near", hit));
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
    const xs = data.nodes.map(n => n.x), ys = data.nodes.map(n => n.y);
    const pad = 60;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const r = stage.getBoundingClientRect();
    const inset = bottomInset || 0;
    const availH = Math.max(120, r.height - inset);
    // 上限 1.15:贴合后不要放得比 1:1 大太多,免得节点显得笨重
    scale = Math.max(0.28, Math.min(1.15, Math.min(r.width / w, availH / h)));
    tx = (r.width - w * scale) / 2 - minX * scale;
    ty = (availH - h * scale) / 2 - minY * scale;
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

  /* ---------------- 手势 ----------------
     全程只更新 tx/ty/scale 三个数,然后写一次 CSS transform。
     不重建 SVG、不重算布局 —— CPU 占用可以忽略。 */

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
      if (mode === "pan" && e.touches.length === 1) {
        const dx = e.touches[0].clientX - sx, dy = e.touches[0].clientY - sy;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        tx = stx + dx; ty = sty + dy;
        apply();
      } else if (mode === "pinch" && e.touches.length === 2) {
        const ns = Math.max(0.1, Math.min(6,
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
        if (mode === "pan" && !moved && cb.onBlank) cb.onBlank();
        mode = null;
      }
    });

    // 桌面端
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
      const ns = Math.max(0.1, Math.min(6,
        scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      tx = px - (px - tx) * (ns / scale);
      ty = py - (py - ty) * (ns / scale);
      scale = ns;
      apply();
    }, { passive: false });
  }

  /* 派系着色开关 */
  function setFactionMode(on) {
    svg.classList.toggle("by-faction", !!on);
  }

  /* 给卡片里的头像用,保证跟图上一致 */
  function nodeColor(id) {
    if (!data) return "var(--n-mid)";
    const n = data.nodes.find(x => x.id === id);
    if (!n) return "var(--n-mid)";
    if (n.is_me) return "var(--accent)";
    if (svg.classList.contains("by-faction")) {
      return n.frank < 3 ? `var(--f${n.frank + 1})` : "var(--f0)";
    }
    const rs = data.nodes.map(x => x.r).sort((a, b) => b - a);
    const hiCut = rs[Math.floor(rs.length * 0.22)] ?? 0;
    const midCut = rs[Math.floor(rs.length * 0.62)] ?? 0;
    return n.r >= hiCut ? "var(--n-hi)"
         : (n.r >= midCut ? "var(--n-mid)" : "var(--n-lo)");
  }

  function currentScale() { return scale; }

  return { init, render, fit, focus, focusEdge, centerOn, nodeColor,
           setFactionMode, currentScale };
})();
