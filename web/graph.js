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

    svg.querySelectorAll(".node").forEach(g => {
      g.addEventListener("click", ev => {
        ev.stopPropagation();
        if (cb.onNode) cb.onNode(+g.dataset.id);
      });
    });
    svg.querySelectorAll(".eg .edge-hit").forEach(p => {
      p.addEventListener("click", ev => {
        ev.stopPropagation();
        if (cb.onEdge) cb.onEdge(+p.parentNode.dataset.a, +p.parentNode.dataset.b);
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

  /* 包围盒必须把名字的宽度算进去。
     只按节点坐标算的后果:iPhone 上最右边那几个人的名字被屏幕边缘切掉半个。 */
  function bbox() {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const fs = style.nameSize;
    for (const n of data.nodes) {
      const halfW = Math.max(n.r, n.name.length * fs * 0.56 / 2) + 6;
      minX = Math.min(minX, n.x - halfW);
      maxX = Math.max(maxX, n.x + halfW);
      minY = Math.min(minY, n.y - n.r - 6);
      maxY = Math.max(maxY, n.y + n.r + fs + 12);
    }
    return { minX, maxX, minY, maxY };
  }

  function fit(bottomInset) {
    if (!data || !data.nodes.length) return;
    const pad = 34;
    const b = bbox();
    const w = Math.max(1, b.maxX - b.minX + pad * 2);
    const h = Math.max(1, b.maxY - b.minY + pad * 2);
    const r = stage.getBoundingClientRect();
    const availH = Math.max(120, r.height - (bottomInset || 0));
    scale = Math.max(0.25, Math.min(1.3, Math.min(r.width / w, availH / h)));
    tx = (r.width - w * scale) / 2 - (b.minX - pad) * scale;
    ty = (availH - h * scale) / 2 - (b.minY - pad) * scale;
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
        if (mode === "pan" && !moved && cb.onBlank) cb.onBlank();
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
           setFactionMode, setStyle };
})();


/* ============================================================
   纯渲染:payload + 样式 → SVG 字符串
   ============================================================ */

const GraphRender = (() => {

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
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
        `<text class="nm" x="${n.x}" ` +
          `y="${(n.y + r + style.nameSize + 4).toFixed(1)}" ` +
          `style="font-size:calc(${style.nameSize}px / var(--gscale,1))">` +
          `${esc(n.name)}</text></g>`);
    }
    out.push("</g>");

    return out.join("");
  }

  return { buildSVG, esc };
})();
