/* 图谱渲染 —— 手机端只做"画",不做任何计算。
 *
 * 坐标是服务端算好的(力导向迭代跑在电脑上),这里拿到就直接生成 SVG。
 * 平移和缩放只改一个 CSS transform,由 GPU 合成,不触发 SVG 重排、
 * 不跑 requestAnimationFrame 循环 —— 这是手机不发热的关键。
 *
 * 配色经 dataviz 校验脚本验证(浅色/深色双主题、all-pairs 模式全部通过):
 *   派系(分类)  取分类色板前 3 槽,第 4 个及以后的圈子归为中性灰
 *                 —— 全配对模式下只有前 3 槽能同时满足色觉障碍与常视觉分辨阈
 *   关系正负     取发散色板 蓝↔红,并给负向边加虚线作为第二重编码
 *                 (不依赖颜色也能区分,对色觉障碍和黑白打印都成立)
 */

const GraphView = (() => {
  const SVG_NS = "http://www.w3.org/2000/svg";

  // dataviz 分类色板前三槽 + 中性灰(第 4 个及以后的圈子)
  const FACTION = {
    light: ["#2a78d6", "#eb6834", "#1baf7a"],
    dark:  ["#3987e5", "#d95926", "#199e70"],
  };
  const OTHER = { light: "#8b909c", dark: "#767d8c" };
  // 发散色板:正向 ↔ 负向
  const EDGE = {
    light: { pos: "#2a78d6", neg: "#e34948" },
    dark:  { pos: "#3987e5", neg: "#e66767" },
  };

  let stage, canvas, svg;
  let data = null;
  let tx = 0, ty = 0, scale = 1;
  let onNodeTap = null;
  let rankOfFaction = new Map();

  const isDark = () =>
    !window.matchMedia || !window.matchMedia("(prefers-color-scheme: light)").matches;

  const mode = () => (isDark() ? "dark" : "light");

  function factionColor(fid) {
    const rank = rankOfFaction.get(fid);
    const pal = FACTION[mode()];
    return rank !== undefined && rank < pal.length ? pal[rank] : OTHER[mode()];
  }

  function apply() {
    canvas.style.transform =
      `translate3d(${tx}px, ${ty}px, 0) scale(${scale})`;
  }

  function init(opts) {
    stage = document.getElementById("stage");
    canvas = document.getElementById("canvas");
    svg = document.getElementById("svg");
    onNodeTap = opts && opts.onNodeTap;
    bindGestures();
    if (window.matchMedia) {
      window.matchMedia("(prefers-color-scheme: dark)")
        .addEventListener("change", () => { if (data) render(data); });
    }
  }

  function render(payload) {
    data = payload;
    svg.setAttribute("viewBox", `0 0 ${payload.width} ${payload.height}`);
    svg.setAttribute("width", payload.width);
    svg.setAttribute("height", payload.height);

    // 按圈子人数排名 —— 人最多的三个圈子拿到分类色,其余归中性灰
    const size = new Map();
    payload.nodes.forEach(n => size.set(n.faction, (size.get(n.faction) || 0) + 1));
    rankOfFaction = new Map(
      [...size.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])
        .map(([fid], i) => [fid, i]));

    const ec = EDGE[mode()];
    const parts = [];

    // 边先画,压在节点下面
    parts.push('<g id="edges">');
    for (const e of payload.edges) {
      const neg = e.w < 0;
      const color = neg ? ec.neg : ec.pos;
      // 负向边用虚线 —— 第二重编码,不靠颜色也能分辨
      const dash = neg ? ' stroke-dasharray="7 5"' : "";
      parts.push(
        `<line class="edge" data-a="${e.a}" data-b="${e.b}" ` +
        `x1="${e.x1}" y1="${e.y1}" x2="${e.x2}" y2="${e.y2}" ` +
        `stroke="${color}" stroke-width="${e.width}" ` +
        `opacity="${neg ? 0.72 : 0.5}"${dash}/>`);
    }
    parts.push("</g>");

    parts.push('<g id="nodes">');
    for (const n of payload.nodes) {
      const fill = factionColor(n.faction);
      const cls = "node" + (n.is_me ? " me" : "");
      parts.push(
        `<g class="${cls}" data-id="${n.id}">` +
        `<circle cx="${n.x}" cy="${n.y}" r="${n.r}" fill="${fill}"/>` +
        `<text class="blurable" x="${n.x}" y="${n.y + n.r + 15}">` +
        `${esc(n.name)}</text></g>`);
    }
    parts.push("</g>");

    svg.innerHTML = parts.join("");

    svg.querySelectorAll(".node").forEach(g => {
      g.addEventListener("click", ev => {
        ev.stopPropagation();
        if (onNodeTap) onNodeTap(parseInt(g.dataset.id, 10));
      });
    });
  }

  function esc(s) {
    return String(s).replace(/[&<>"]/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /* 高亮某人及其直接关系,其余淡出 */
  function focus(pid) {
    if (pid === null || pid === undefined) {
      svg.querySelectorAll(".node").forEach(g => g.classList.remove("dim"));
      svg.querySelectorAll(".edge").forEach(l => (l.style.opacity = ""));
      return;
    }
    const near = new Set([pid]);
    svg.querySelectorAll(".edge").forEach(l => {
      const a = +l.dataset.a, b = +l.dataset.b;
      if (a === pid || b === pid) { near.add(a); near.add(b); l.style.opacity = "0.95"; }
      else l.style.opacity = "0.06";
    });
    svg.querySelectorAll(".node").forEach(g => {
      g.classList.toggle("dim", !near.has(+g.dataset.id));
    });
  }

  function fit() {
    if (!data || !data.nodes.length) return;
    const xs = data.nodes.map(n => n.x), ys = data.nodes.map(n => n.y);
    const pad = 60;
    const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
    const w = Math.max(1, maxX - minX), h = Math.max(1, maxY - minY);
    const r = stage.getBoundingClientRect();
    scale = Math.min(r.width / w, r.height / h);
    scale = Math.max(0.15, Math.min(3, scale));
    tx = (r.width - w * scale) / 2 - minX * scale;
    ty = (r.height - h * scale) / 2 - minY * scale;
    apply();
  }

  /* ---------- 手势 ----------
     全程只更新 tx/ty/scale 三个数,然后写一次 CSS transform。
     不重建 SVG、不重算布局 —— 所以 CPU 占用可以忽略。            */
  function bindGestures() {
    let mode_ = null;          // "pan" | "pinch"
    let startX = 0, startY = 0, startTx = 0, startTy = 0;
    let startDist = 0, startScale = 1, pivot = null;
    let moved = false;

    const dist = (t1, t2) =>
      Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
    const mid = (t1, t2) => ({
      x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2,
    });

    stage.addEventListener("touchstart", e => {
      if (e.touches.length === 1) {
        mode_ = "pan"; moved = false;
        startX = e.touches[0].clientX; startY = e.touches[0].clientY;
        startTx = tx; startTy = ty;
      } else if (e.touches.length === 2) {
        mode_ = "pinch";
        startDist = dist(e.touches[0], e.touches[1]) || 1;
        startScale = scale;
        const m = mid(e.touches[0], e.touches[1]);
        const r = stage.getBoundingClientRect();
        pivot = { x: m.x - r.left, y: m.y - r.top };
        startTx = tx; startTy = ty;
      }
    }, { passive: true });

    stage.addEventListener("touchmove", e => {
      if (mode_ === "pan" && e.touches.length === 1) {
        const dx = e.touches[0].clientX - startX;
        const dy = e.touches[0].clientY - startY;
        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) moved = true;
        tx = startTx + dx; ty = startTy + dy;
        apply();
      } else if (mode_ === "pinch" && e.touches.length === 2) {
        moved = true;
        const k = dist(e.touches[0], e.touches[1]) / startDist;
        const ns = Math.max(0.1, Math.min(6, startScale * k));
        // 以两指中点为锚保持不动
        tx = pivot.x - (pivot.x - startTx) * (ns / startScale);
        ty = pivot.y - (pivot.y - startTy) * (ns / startScale);
        scale = ns;
        apply();
      }
      e.preventDefault();
    }, { passive: false });

    stage.addEventListener("touchend", e => {
      if (e.touches.length === 0) {
        if (mode_ === "pan" && !moved && onNodeTap) onNodeTap(null); // 点空白处收起
        mode_ = null;
      }
    });

    // 桌面端:拖拽 + 滚轮
    let dragging = false;
    stage.addEventListener("mousedown", e => {
      dragging = true; moved = false;
      startX = e.clientX; startY = e.clientY; startTx = tx; startTy = ty;
    });
    window.addEventListener("mousemove", e => {
      if (!dragging) return;
      const dx = e.clientX - startX, dy = e.clientY - startY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved = true;
      tx = startTx + dx; ty = startTy + dy;
      apply();
    });
    window.addEventListener("mouseup", () => { dragging = false; });
    stage.addEventListener("wheel", e => {
      e.preventDefault();
      const r = stage.getBoundingClientRect();
      const px = e.clientX - r.left, py = e.clientY - r.top;
      const ns = Math.max(0.1, Math.min(6, scale * (e.deltaY < 0 ? 1.12 : 1 / 1.12)));
      tx = px - (px - tx) * (ns / scale);
      ty = py - (py - ty) * (ns / scale);
      scale = ns;
      apply();
    }, { passive: false });
  }

  function centerOn(pid) {
    if (!data) return;
    const n = data.nodes.find(x => x.id === pid);
    if (!n) return;
    const r = stage.getBoundingClientRect();
    scale = Math.max(scale, 1);
    tx = r.width / 2 - n.x * scale;
    ty = r.height / 2 - n.y * scale;
    apply();
  }

  return { init, render, fit, focus, centerOn, factionColor };
})();
