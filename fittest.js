/* 贴合算法的确定性验证:断言复位后所有名字的屏幕包围盒都落在视口内。
   这是上一版栽跟头的地方 —— 当时只肉眼估没算,把屏幕像素和画布单位搞混了。 */
const fs = require("fs"), path = require("path"), os = require("os");

const src = fs.readFileSync(path.join(__dirname, "web", "graph.js"), "utf8");
const tmp = path.join(os.tmpdir(), "_graph_for_test.js");
fs.writeFileSync(tmp, src + "\n;module.exports={GraphRender,GraphStyles};");
const { GraphRender, GraphStyles } = require(tmp);

let ok = 0, fail = 0;
const check = (label, cond, detail) => {
  if (cond) { console.log("  ✓ " + label); ok++; }
  else { console.log("  ✗ " + label + (detail ? "  —— " + detail : "")); fail++; }
};

const LABEL_GAP = 6;      // 与 graph.js 保持一致
const CHAR_W = 0.58;

/* 渲染器实际把名字画在哪(换算成屏幕坐标):
     文字基线画布 y = n.y + r + 4,再叠加 CSS transform translateY(nameSize/scale)
     所以屏幕基线 y = (n.y + r + 4) * scale + ty + nameSize            */
function labelScreenBox(n, f, nameSize) {
  const halfW = String(n.name).length * nameSize * CHAR_W / 2;
  const cx = n.x * f.scale + f.tx;
  const baseline = (n.y + n.r + 4) * f.scale + f.ty + nameSize;
  return { left: cx - halfW, right: cx + halfW,
           top: baseline - nameSize * 0.8, bottom: baseline + nameSize * 0.25 };
}
function nodeScreenBox(n, f) {
  const cx = n.x * f.scale + f.tx, cy = n.y * f.scale + f.ty;
  const r = n.r * f.scale;
  return { left: cx - r, right: cx + r, top: cy - r, bottom: cy + r };
}

function runCase(title, nodes, opt) {
  const nameSize = opt.nameSize;
  const f = GraphRender.computeFit(nodes, opt);
  const usableBottom = opt.stageH - (opt.bottomInset || 0);
  let worstL = Infinity, worstR = -Infinity, worstT = Infinity, worstB = -Infinity;
  let bad = null;
  for (const n of nodes) {
    for (const b of [labelScreenBox(n, f, nameSize), nodeScreenBox(n, f)]) {
      worstL = Math.min(worstL, b.left);   worstR = Math.max(worstR, b.right);
      worstT = Math.min(worstT, b.top);    worstB = Math.max(worstB, b.bottom);
      if (b.left < -0.5 || b.right > opt.stageW + 0.5 ||
          b.top < -0.5 || b.bottom > usableBottom + 0.5) bad = bad || n.name;
    }
  }
  check(title, !bad,
    `「${bad}」出界:左 ${worstL.toFixed(1)} 右 ${worstR.toFixed(1)}` +
    ` 上 ${worstT.toFixed(1)} 下 ${worstB.toFixed(1)}` +
    `(视口 ${opt.stageW}×${usableBottom})`);
  return { f, worstL, worstR, worstT, worstB, usableBottom };
}

// ---------- 造数据 ----------
function grid(cols, rows, W, H, names) {
  const out = [];
  let i = 0;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    out.push({ id: i, name: names[i % names.length],
               x: 40 + c * (W - 80) / Math.max(1, cols - 1),
               y: 40 + r * (H - 80) / Math.max(1, rows - 1),
               r: 14 + (i % 3) * 6 });
    i++;
  }
  return out;
}
const CN3 = ["陈国栋", "李明远", "王海涛", "苏明哲", "周文彬"];
const LONG = ["欧阳明日香", "司马长风逸", "诸葛云天翔"];

console.log("\n复位后名字是否会被裁(这是用户报的 bug)");

// 桌面宽屏
runCase("桌面 1900×760,19 人 3 字名",
  grid(5, 4, 1462, 877, CN3).slice(0, 19),
  { stageW: 1900, stageH: 760, bottomInset: 110, nameSize: 12.5 });

// iPhone 竖屏
runCase("iPhone 390×640,19 人 3 字名",
  grid(4, 5, 741, 1150, CN3).slice(0, 19),
  { stageW: 390, stageH: 640, bottomInset: 120, nameSize: 12.5 });

// 极端:超长名字 + 节点贴在画布四角
runCase("超长名字(5 字)+ 节点贴在画布四角",
  [{ id: 1, name: LONG[0], x: 20, y: 20, r: 30 },
   { id: 2, name: LONG[1], x: 1480, y: 20, r: 30 },
   { id: 3, name: LONG[2], x: 20, y: 880, r: 30 },
   { id: 4, name: LONG[0], x: 1480, y: 880, r: 30 }],
  { stageW: 1200, stageH: 700, bottomInset: 100, nameSize: 13.5 });

runCase("iPhone + 超长名字(最容易裁的组合)",
  [{ id: 1, name: LONG[0], x: 20, y: 20, r: 26 },
   { id: 2, name: LONG[1], x: 720, y: 20, r: 26 },
   { id: 3, name: LONG[2], x: 20, y: 1130, r: 26 },
   { id: 4, name: LONG[0], x: 720, y: 1130, r: 26 }],
  { stageW: 390, stageH: 620, bottomInset: 130, nameSize: 13.5 });

runCase("只有一个人", [{ id: 1, name: "苏明哲", x: 500, y: 500, r: 30 }],
  { stageW: 900, stageH: 600, bottomInset: 100, nameSize: 12.5 });

runCase("很挤:60 人", grid(10, 6, 2598, 1558, CN3),
  { stageW: 1600, stageH: 800, bottomInset: 110, nameSize: 11.5 });

console.log("\n缩放与居中");
const r1 = runCase("窄视口下缩放不会越界",
  grid(4, 4, 1000, 1000, CN3), { stageW: 320, stageH: 500,
  bottomInset: 100, nameSize: 12.5 });
check("缩放落在允许区间内", r1.f.scale >= 0.2 && r1.f.scale <= 1.3,
      String(r1.f.scale));

const opt = { stageW: 1200, stageH: 700, bottomInset: 100, nameSize: 12.5 };
const ns = grid(4, 4, 1000, 1000, CN3);
const f = GraphRender.computeFit(ns, opt);
const cxs = ns.map(n => n.x * f.scale + f.tx);
const midX = (Math.min(...cxs) + Math.max(...cxs)) / 2;
check("水平方向大致居中", Math.abs(midX - opt.stageW / 2) < 2,
      `内容中心 ${midX.toFixed(1)} vs 视口中心 ${opt.stageW / 2}`);

console.log("\n真实布局数据:名字确实会越过 viewBox(所以 #svg 必须 overflow:visible)");
/* 这份 fixture 是 layout.py 对「公司圈」19 人算出的真实坐标(见 demo_seed.json)。
   布局只保证圆心落在 [0,width]×[0,height] 内 —— selftest.py 断言的正是这一条。
   名字画在圆心两侧,必然越界;SVG 最外层默认 overflow:hidden 就会把它裁掉。
   这就是用户截图里「韩雪梅」只剩「雪梅」的原因。 */
const FIXTURE = {"wide": {"width": 1462.0, "height": 877.2, "nodes": [["陈国栋", 1285.6, 574.6, 24.5], ["李明远", 1250.8, 367.3, 17.2], ["王海涛", 1442.0, 770.2, 17.1], ["赵晓峰", 1442.0, 416.9, 18.1], ["孙志强", 1442.0, 313.4, 18.4], ["周文彬", 291.8, 723.5, 27.0], ["吴秀兰", 215.4, 857.2, 18.1], ["郑天成", 81.5, 857.2, 17.0], ["冯玉洁", 20.0, 857.2, 18.3], ["何建军", 20.0, 620.8, 17.0], ["许宏伟", 349.4, 139.4, 25.7], ["沈丽娟", 125.0, 20.0, 17.1], ["韩雪梅", 20.0, 20.0, 17.1], ["杨立国", 234.8, 20.0, 17.0], ["林子豪", 780.0, 556.9, 33.0], ["苏明哲", 1154.4, 690.0, 18.8], ["高伟", 1442.0, 20.0, 17.0], ["罗小敏", 412.7, 857.2, 17.0], ["曹明", 501.8, 20.0, 17.0]]}, "portrait": {"width": 740.8, "height": 1150.1, "nodes": [["陈国栋", 720.8, 434.9, 24.5], ["李明远", 720.8, 570.6, 17.2], ["王海涛", 720.8, 144.8, 17.1], ["赵晓峰", 720.8, 245.5, 18.1], ["孙志强", 720.8, 315.2, 18.4], ["周文彬", 172.2, 952.3, 27.0], ["吴秀兰", 206.7, 1130.1, 18.1], ["郑天成", 20.0, 1130.1, 17.0], ["冯玉洁", 20.0, 1064.4, 18.3], ["何建军", 20.0, 895.4, 17.0], ["许宏伟", 83.3, 235.5, 25.7], ["沈丽娟", 20.0, 123.2, 17.1], ["韩雪梅", 20.0, 20.0, 17.1], ["杨立国", 98.0, 20.0, 17.0], ["林子豪", 360.3, 582.4, 33.0], ["苏明哲", 584.6, 453.1, 18.8], ["高伟", 720.8, 20.0, 17.0], ["罗小敏", 376.0, 1130.1, 17.0], ["曹明", 233.2, 20.0, 17.0]]}};

for (const [bucket, fx] of Object.entries(FIXTURE)) {
  // 复位后典型缩放约 0.45;名字在画布单位里的宽度 = 字数 × (nameSize/scale) × CHAR_W
  const S = 0.45, NS = 12.5;
  const over = fx.nodes.filter(([name, x]) => {
    const hw = name.length * (NS / S) * CHAR_W / 2;
    return x - hw < 0 || x + hw > fx.width;
  });
  check(`${bucket}:真实数据里有 ${over.length} 个名字越过 viewBox`,
        over.length > 0,
        "一个都没越界 —— 说明我对裁切根因的判断是错的,别急着改代码");
}

const css = fs.readFileSync(path.join(__dirname, "web", "style.css"), "utf8");
check("#svg 声明了 overflow:visible(删掉它名字就会被裁回去)",
      /#svg\s*\{[^}]*overflow\s*:\s*visible/.test(css),
      "style.css 里 #svg 的 overflow:visible 没了");
check("#stage 仍然 overflow:hidden(视口才是该裁的地方)",
      /#stage\s*\{[^}]*overflow\s*:\s*hidden/.test(css));

console.log("\n拖动依赖的两条不变量(手抄的数学 + 索引对齐)");
/* 这份 payload 是服务端真算出来的 —— 弧线控制点是 layout._arc 的输出。
   前端的 GraphRender.arc 是我照着那段 Python 手抄过来的,
   拖动时全靠它重算路径。抄错一个符号,线就会歪到别处去,而且只在拖动时才看得见。 */
const PL = {"width": 1462.0191517213445, "height": 877.2114910328067, "nodes": [{"id": 1, "name": "陈国栋", "x": 1285.6, "y": 574.6, "r": 24.5, "initial": "陈", "frank": 0, "is_me": false}, {"id": 2, "name": "李明远", "x": 1250.8, "y": 367.3, "r": 17.2, "initial": "李", "frank": 0, "is_me": false}, {"id": 3, "name": "王海涛", "x": 1442.0, "y": 770.2, "r": 17.1, "initial": "王", "frank": 0, "is_me": false}, {"id": 4, "name": "赵晓峰", "x": 1442.0, "y": 416.9, "r": 18.1, "initial": "赵", "frank": 0, "is_me": false}, {"id": 5, "name": "孙志强", "x": 1442.0, "y": 313.4, "r": 18.4, "initial": "孙", "frank": 0, "is_me": false}, {"id": 6, "name": "周文彬", "x": 291.8, "y": 723.5, "r": 27.0, "initial": "周", "frank": 1, "is_me": false}, {"id": 7, "name": "吴秀兰", "x": 215.4, "y": 857.2, "r": 18.1, "initial": "吴", "frank": 1, "is_me": false}, {"id": 8, "name": "郑天成", "x": 81.5, "y": 857.2, "r": 17.0, "initial": "郑", "frank": 1, "is_me": false}, {"id": 9, "name": "冯玉洁", "x": 20.0, "y": 857.2, "r": 18.3, "initial": "冯", "frank": 1, "is_me": false}, {"id": 10, "name": "何建军", "x": 20.0, "y": 620.8, "r": 17.0, "initial": "何", "frank": 1, "is_me": false}, {"id": 11, "name": "许宏伟", "x": 349.4, "y": 139.4, "r": 25.7, "initial": "许", "frank": 2, "is_me": false}, {"id": 12, "name": "沈丽娟", "x": 125.0, "y": 20.0, "r": 17.1, "initial": "沈", "frank": 2, "is_me": false}, {"id": 13, "name": "韩雪梅", "x": 20.0, "y": 20.0, "r": 17.1, "initial": "韩", "frank": 2, "is_me": false}, {"id": 14, "name": "杨立国", "x": 234.8, "y": 20.0, "r": 17.0, "initial": "杨", "frank": 2, "is_me": false}, {"id": 15, "name": "林子豪", "x": 780.0, "y": 556.9, "r": 33.0, "initial": "林", "frank": 0, "is_me": false}, {"id": 16, "name": "苏明哲", "x": 1154.4, "y": 690.0, "r": 18.8, "initial": "苏", "frank": 0, "is_me": true}, {"id": 17, "name": "高伟", "x": 1442.0, "y": 20.0, "r": 17.0, "initial": "高", "frank": 0, "is_me": false}, {"id": 18, "name": "罗小敏", "x": 412.7, "y": 857.2, "r": 17.0, "initial": "罗", "frank": 1, "is_me": false}, {"id": 19, "name": "曹明", "x": 501.8, "y": 20.0, "r": 17.0, "initial": "曹", "frank": 2, "is_me": false}], "edges": [{"a": 1, "b": 2, "x1": 1285.6, "y1": 574.6, "x2": 1250.8, "y2": 367.3, "cx": 1288.9, "cy": 467.5, "mx": 1278.6, "my": 469.2, "w": 3, "width": 2.21, "glyph": "▪", "label": "派系盟友", "count": 1, "ecx": 1288.9299999999998, "ecy": 467.47, "eqx": 1278.5649999999998, "eqy": 469.21}, {"a": 1, "b": 3, "x1": 1285.6, "y1": 574.6, "x2": 1442.0, "y2": 770.2, "cx": 1344.2, "cy": 688.0, "mx": 1354.0, "my": 680.2, "w": 2, "width": 1.74, "glyph": "▪", "label": "派系盟友", "count": 1, "ecx": 1344.24, "ecy": 688.0400000000001, "eqx": 1354.02, "eqy": 680.22}, {"a": 1, "b": 4, "x1": 1285.6, "y1": 574.6, "x2": 1442.0, "y2": 416.9, "cx": 1379.6, "cy": 511.4, "mx": 1371.7, "my": 503.6, "w": 3, "width": 2.21, "glyph": "▪", "label": "师徒", "count": 1, "ecx": 1379.57, "ecy": 511.39, "eqx": 1371.685, "eqy": 503.57000000000005}, {"a": 2, "b": 4, "x1": 1250.8, "y1": 367.3, "x2": 1442.0, "y2": 416.9, "cx": 1341.5, "cy": 411.2, "mx": 1344.0, "my": 401.6, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1341.44, "ecy": 411.22, "eqx": 1343.92, "eqy": 401.65999999999997}, {"a": 3, "b": 5, "x1": 1442.0, "y1": 770.2, "x2": 1442.0, "y2": 313.4, "cx": 1487.7, "cy": 541.8, "mx": 1464.9, "my": 541.8, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1487.68, "ecy": 541.8, "eqx": 1464.8400000000001, "eqy": 541.8}, {"a": 1, "b": 5, "x1": 1285.6, "y1": 574.6, "x2": 1442.0, "y2": 313.4, "cx": 1389.9, "cy": 459.6, "mx": 1376.9, "my": 451.8, "w": 1, "width": 1.27, "glyph": "▪", "label": "上下级", "count": 1, "ecx": 1389.92, "ecy": 459.64, "eqx": 1376.8600000000001, "eqy": 451.82000000000005}, {"a": 2, "b": 5, "x1": 1250.8, "y1": 367.3, "x2": 1442.0, "y2": 313.4, "cx": 1351.8, "cy": 359.5, "mx": 1349.1, "my": 349.9, "w": 1, "width": 1.27, "glyph": "▪", "label": "同事", "count": 1, "ecx": 1351.7900000000002, "ecy": 359.47, "eqx": 1349.095, "eqy": 349.90999999999997}, {"a": 4, "b": 5, "x1": 1442.0, "y1": 416.9, "x2": 1442.0, "y2": 313.4, "cx": 1452.4, "cy": 365.1, "mx": 1447.2, "my": 365.1, "w": 1, "width": 1.27, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1452.35, "ecy": 365.15, "eqx": 1447.175, "eqy": 365.15}, {"a": 6, "b": 7, "x1": 291.8, "y1": 723.5, "x2": 215.4, "y2": 857.2, "cx": 240.3, "cy": 782.7, "mx": 246.9, "my": 786.5, "w": 3, "width": 2.21, "glyph": "▪", "label": "派系盟友", "count": 1, "ecx": 240.23000000000002, "ecy": 782.71, "eqx": 246.915, "eqy": 786.53}, {"a": 6, "b": 8, "x1": 291.8, "y1": 723.5, "x2": 81.5, "y2": 857.2, "cx": 173.3, "cy": 769.3, "mx": 180.0, "my": 779.8, "w": 2, "width": 1.74, "glyph": "▪", "label": "派系盟友", "count": 1, "ecx": 173.28, "ecy": 769.32, "eqx": 179.965, "eqy": 779.835}, {"a": 6, "b": 9, "x1": 291.8, "y1": 723.5, "x2": 20.0, "y2": 857.2, "cx": 142.5, "cy": 763.2, "mx": 149.2, "my": 776.8, "w": 2, "width": 1.74, "glyph": "▪", "label": "师徒", "count": 1, "ecx": 142.53, "ecy": 763.1700000000001, "eqx": 149.215, "eqy": 776.76}, {"a": 7, "b": 8, "x1": 215.4, "y1": 857.2, "x2": 81.5, "y2": 857.2, "cx": 148.4, "cy": 843.8, "mx": 148.4, "my": 850.5, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 148.45, "ecy": 843.8100000000001, "eqx": 148.45, "eqy": 850.5050000000001}, {"a": 8, "b": 9, "x1": 81.5, "y1": 857.2, "x2": 20.0, "y2": 857.2, "cx": 50.7, "cy": 851.1, "mx": 50.7, "my": 854.1, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 50.75, "ecy": 851.0500000000001, "eqx": 50.75, "eqy": 854.125}, {"a": 6, "b": 10, "x1": 291.8, "y1": 723.5, "x2": 20.0, "y2": 620.8, "cx": 166.2, "cy": 645.0, "mx": 161.0, "my": 658.5, "w": 3, "width": 2.21, "glyph": "▪", "label": "提携", "count": 1, "ecx": 166.17000000000002, "ecy": 644.97, "eqx": 161.03500000000003, "eqy": 658.56}, {"a": 9, "b": 10, "x1": 20.0, "y1": 857.2, "x2": 20.0, "y2": 620.8, "cx": 43.6, "cy": 739.0, "mx": 31.8, "my": 739.0, "w": 1, "width": 1.27, "glyph": "●", "label": "朋友", "count": 1, "ecx": 43.640000000000015, "ecy": 739.0, "eqx": 31.820000000000007, "eqy": 739.0}, {"a": 11, "b": 12, "x1": 349.4, "y1": 139.4, "x2": 125.0, "y2": 20.0, "cx": 249.1, "cy": 57.2, "mx": 243.2, "my": 68.5, "w": 3, "width": 2.21, "glyph": "▪", "label": "派系盟友", "count": 1, "ecx": 249.14, "ecy": 57.260000000000005, "eqx": 243.17, "eqy": 68.48}, {"a": 11, "b": 13, "x1": 349.4, "y1": 139.4, "x2": 20.0, "y2": 20.0, "cx": 196.7, "cy": 46.8, "mx": 190.7, "my": 63.2, "w": 2, "width": 1.74, "glyph": "▪", "label": "派系盟友", "count": 1, "ecx": 196.64, "ecy": 46.760000000000005, "eqx": 190.67, "eqy": 63.230000000000004}, {"a": 11, "b": 14, "x1": 349.4, "y1": 139.4, "x2": 234.8, "y2": 20.0, "cx": 304.1, "cy": 68.2, "mx": 298.1, "my": 74.0, "w": 2, "width": 1.74, "glyph": "▪", "label": "提携", "count": 1, "ecx": 304.04, "ecy": 68.24000000000001, "eqx": 298.07, "eqy": 73.97}, {"a": 12, "b": 13, "x1": 125.0, "y1": 20.0, "x2": 20.0, "y2": 20.0, "cx": 72.5, "cy": 9.5, "mx": 72.5, "my": 14.8, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 72.5, "ecy": 9.5, "eqx": 72.5, "eqy": 14.75}, {"a": 13, "b": 14, "x1": 20.0, "y1": 20.0, "x2": 234.8, "y2": 20.0, "cx": 127.4, "cy": 41.5, "mx": 127.4, "my": 30.7, "w": 1, "width": 1.27, "glyph": "●", "label": "朋友", "count": 1, "ecx": 127.4, "ecy": 41.480000000000004, "eqx": 127.4, "eqy": 30.740000000000002}, {"a": 1, "b": 6, "x1": 1285.6, "y1": 574.6, "x2": 291.8, "y2": 723.5, "cx": 780.1, "cy": 591.7, "mx": 784.4, "my": 620.4, "w": -3, "width": 2.21, "glyph": "●", "label": "敌对", "count": 1, "ecx": 780.1103321152453, "ecy": 591.7201682748884, "eqx": 784.4051660576226, "eqy": 620.3850841374442}, {"a": 1, "b": 11, "x1": 1285.6, "y1": 574.6, "x2": 349.4, "y2": 139.4, "cx": 841.9, "cy": 304.4, "mx": 829.7, "my": 330.7, "w": -2, "width": 1.74, "glyph": "●", "label": "敌对", "count": 1, "ecx": 841.9364608078058, "ecy": 304.43241128614926, "eqx": 829.7182304039029, "eqy": 330.71620564307466}, {"a": 6, "b": 11, "x1": 291.8, "y1": 723.5, "x2": 349.4, "y2": 139.4, "cx": 378.3, "cy": 437.1, "mx": 349.5, "my": 434.3, "w": -2, "width": 1.74, "glyph": "●", "label": "敌对", "count": 1, "ecx": 378.2899244350091, "ecy": 437.1389910074585, "eqx": 349.44496221750455, "eqy": 434.2944955037293}, {"a": 2, "b": 8, "x1": 1250.8, "y1": 367.3, "x2": 81.5, "y2": 857.2, "cx": 643.7, "cy": 558.8, "mx": 654.9, "my": 585.5, "w": -2, "width": 1.74, "glyph": "¥", "label": "竞争", "count": 1, "ecx": 643.749113986406, "ecy": 558.7832598169108, "eqx": 654.949556993203, "eqy": 585.5166299084553}, {"a": 3, "b": 7, "x1": 1442.0, "y1": 770.2, "x2": 215.4, "y2": 857.2, "cx": 824.6, "cy": 755.9, "mx": 826.7, "my": 784.8, "w": -2, "width": 1.74, "glyph": "¥", "label": "利益冲突", "count": 1, "ecx": 824.5986384960894, "ecy": 755.8755170034851, "eqx": 826.6493192480447, "eqy": 784.7877585017425}, {"a": 6, "b": 13, "x1": 291.8, "y1": 723.5, "x2": 20.0, "y2": 20.0, "cx": 210.0, "cy": 350.9, "mx": 183.0, "my": 361.3, "w": -2, "width": 1.74, "glyph": "●", "label": "敌对", "count": 1, "ecx": 209.97425151745043, "ecy": 350.85819962694666, "eqx": 182.93712575872522, "eqy": 361.30409981347333}, {"a": 2, "b": 3, "x1": 1250.8, "y1": 367.3, "x2": 1442.0, "y2": 770.2, "cx": 1306.1, "cy": 587.8, "mx": 1326.3, "my": 578.3, "w": -3, "width": 2.21, "glyph": "●", "label": "敌对", "count": 1, "ecx": 1306.1100000000001, "ecy": 587.87, "eqx": 1326.255, "eqy": 578.31}, {"a": 1, "b": 16, "x1": 1285.6, "y1": 574.6, "x2": 1154.4, "y2": 690.0, "cx": 1208.5, "cy": 619.2, "mx": 1214.2, "my": 625.7, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1208.46, "ecy": 619.18, "eqx": 1214.23, "eqy": 625.74}, {"a": 2, "b": 16, "x1": 1250.8, "y1": 367.3, "x2": 1154.4, "y2": 690.0, "cx": 1170.4, "cy": 519.0, "mx": 1186.5, "my": 523.8, "w": 3, "width": 2.21, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1170.33, "ecy": 519.01, "eqx": 1186.4650000000001, "eqy": 523.8299999999999}, {"a": 3, "b": 16, "x1": 1442.0, "y1": 770.2, "x2": 1154.4, "y2": 690.0, "cx": 1306.2, "cy": 701.3, "mx": 1302.2, "my": 715.7, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1306.22, "ecy": 701.34, "eqx": 1302.21, "eqy": 715.72}, {"a": 15, "b": 16, "x1": 780.0, "y1": 556.9, "x2": 1154.4, "y2": 690.0, "cx": 953.9, "cy": 660.9, "mx": 960.5, "my": 642.2, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 953.89, "ecy": 660.8900000000001, "eqx": 960.545, "eqy": 642.1700000000001}, {"a": 1, "b": 15, "x1": 1285.6, "y1": 574.6, "x2": 780.0, "y2": 556.9, "cx": 1034.5, "cy": 515.2, "mx": 1033.6, "my": 540.5, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1034.57, "ecy": 515.19, "eqx": 1033.685, "eqy": 540.47}, {"a": 6, "b": 15, "x1": 291.8, "y1": 723.5, "x2": 780.0, "y2": 556.9, "cx": 552.6, "cy": 689.0, "mx": 544.2, "my": 664.6, "w": 2, "width": 1.74, "glyph": "●", "label": "朋友", "count": 1, "ecx": 552.56, "ecy": 689.0200000000001, "eqx": 544.23, "eqy": 664.61}, {"a": 11, "b": 15, "x1": 349.4, "y1": 139.4, "x2": 780.0, "y2": 556.9, "cx": 524.3, "cy": 389.7, "mx": 544.5, "my": 368.9, "w": 1, "width": 1.27, "glyph": "●", "label": "点头之交", "count": 1, "ecx": 524.347165629429, "ecy": 389.7689951615997, "eqx": 544.5235828147145, "eqy": 368.95949758079985}, {"a": 4, "b": 17, "x1": 1442.0, "y1": 416.9, "x2": 1442.0, "y2": 20.0, "cx": 1481.7, "cy": 218.4, "mx": 1461.9, "my": 218.4, "w": 1, "width": 1.27, "glyph": "▪", "label": "同事", "count": 1, "ecx": 1481.69, "ecy": 218.45, "eqx": 1461.845, "eqy": 218.45}, {"a": 5, "b": 17, "x1": 1442.0, "y1": 313.4, "x2": 1442.0, "y2": 20.0, "cx": 1471.4, "cy": 166.7, "mx": 1456.7, "my": 166.7, "w": 1, "width": 1.27, "glyph": "●", "label": "朋友", "count": 1, "ecx": 1471.34, "ecy": 166.7, "eqx": 1456.67, "eqy": 166.7}, {"a": 7, "b": 18, "x1": 215.4, "y1": 857.2, "x2": 412.7, "y2": 857.2, "cx": 314.1, "cy": 876.9, "mx": 314.1, "my": 867.1, "w": 1, "width": 1.27, "glyph": "▪", "label": "上下级", "count": 1, "ecx": 314.05, "ecy": 876.9300000000001, "eqx": 314.05, "eqy": 867.065}, {"a": 9, "b": 18, "x1": 20.0, "y1": 857.2, "x2": 412.7, "y2": 857.2, "cx": 216.4, "cy": 896.5, "mx": 216.4, "my": 876.8, "w": 1, "width": 1.27, "glyph": "●", "label": "朋友", "count": 1, "ecx": 216.35, "ecy": 896.47, "eqx": 216.35, "eqy": 876.835}, {"a": 12, "b": 19, "x1": 125.0, "y1": 20.0, "x2": 501.8, "y2": 20.0, "cx": 313.4, "cy": 57.7, "mx": 313.4, "my": 38.8, "w": 1, "width": 1.27, "glyph": "▪", "label": "上下级", "count": 1, "ecx": 313.4, "ecy": 57.68, "eqx": 313.4, "eqy": 38.84}, {"a": 11, "b": 19, "x1": 349.4, "y1": 139.4, "x2": 501.8, "y2": 20.0, "cx": 437.6, "cy": 94.9, "mx": 431.6, "my": 87.3, "w": 1, "width": 1.27, "glyph": "▪", "label": "同事", "count": 1, "ecx": 437.54, "ecy": 94.94000000000001, "eqx": 431.57, "eqy": 87.32000000000001}], "density": 1.0};

// 1. 前端弧线数学必须和服务端逐条对上。
//    基准用的是服务端拿**同样已 round 的端点**重算、且未再 round 的输出 ——
//    前后端输入完全相同,所以任何差异都只可能来自公式本身,而不是量化误差。
const cap = GraphRender.curveCap(PL);
let maxErr = 0, worstEdge = null;
for (const e of PL.edges) {
  const a = GraphRender.arc(e.x1, e.y1, e.x2, e.y2, cap);
  const err = Math.max(Math.abs(a.cx - e.ecx), Math.abs(a.cy - e.ecy),
                       Math.abs(a.qx - e.eqx), Math.abs(a.qy - e.eqy));
  if (err > maxErr) { maxErr = err; worstEdge = `${e.a}-${e.b}`; }
}
check(`前端 arc() 与服务端 _arc() 逐条一致(${PL.edges.length} 条,` +
      `最大偏差 ${maxErr.toExponential(1)})`,
      maxErr < 1e-9,
      `边 ${worstEdge} 偏了 ${maxErr},公式抄错了`);

// 2. buildIndex 假设"第 i 个 .eg 元素 == payload.edges[i]",这条必须成立
const svgStr = GraphRender.buildSVG(PL, GraphStyles.B);
const order = [...svgStr.matchAll(/<g class="eg [^"]*" data-a="(\d+)" data-b="(\d+)"/g)]
  .map(m => m[1] + "-" + m[2]);
const want = PL.edges.map(e => e.a + "-" + e.b);
check(`.eg 元素的顺序与 payload.edges 一一对应(${order.length} 条)`,
      order.length === want.length && order.every((v, i) => v === want[i]),
      "顺序对不上,邻接索引会把边接到错误的节点上");

// 3. 流光渐变的 id 必须能被 refreshEdgesOf 找到,否则拖动时线会"秃"
const missing = PL.edges.filter(e => !svgStr.includes(`id="e${e.a}_${e.b}"`));
check(`每条边都有可寻址的流光渐变(缺 ${missing.length} 条)`,
      missing.length === 0,
      "渐变 id 对不上,拖动时渐变会留在原地");

// 4. 悬停/拖动要改的 class 在样式表里得真有对应规则
for (const sel of ["#svg.hovering", ".node.hot", ".node.dragging",
                   "#svg.has-drag"]) {
  check(`样式表里有 ${sel} 的规则`, css.includes(sel),
        "JS 会加这个 class,但 CSS 里没有它 —— 加了等于没加");
}

console.log("\n本轮补的三处(容易被后来的改动悄悄抹掉)");
const gjs = fs.readFileSync(path.join(__dirname, "web", "graph.js"), "utf8");
const ajs = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");

check("松手后会飘回原位(releaseNode + 逐节点的动画句柄)",
      gjs.includes("function releaseNode") && gjs.includes("it.ret"),
      "拖完不回位的话,图就被用户改乱了 —— 而位置根本没存");
check("松手时先结算掉 rAF 里排队的那一帧",
      /if \(rafId\) \{ cancelAnimationFrame\(rafId\); rafId = 0; \}/.test(gjs),
      "不清掉的话归位动画起步后它才落地,球会弹回松手位置");
check("图区禁用了 iOS 的长按选词",
      /#stage\{[^}]*-webkit-user-select:\s*none/.test(css) &&
      /#stage\{[^}]*-webkit-touch-callout:\s*none/.test(css),
      "长按拖动会变成长按选词,整片图被选蓝");
check("双击文件打开时,主界面会给出明确提示",
      ajs.includes('location.protocol === "file:"'));

/* 定稿:视觉档位定为 A,对比页删掉。
   compare.html 有三处引用会跟着断(_pagecheck.py、本文件两处),
   所以这一条同时核对"文件没了"和"引用也没了" —— 只删文件的话,
   _pagecheck.py 会在 urlopen 上抛 404,而那看起来像是服务坏了。 */
check("web/compare.html 已删除",
      !fs.existsSync(path.join(__dirname, "web", "compare.html")));
/* _pagecheck.py 是不进仓库的本地检查(「_」开头的都是),
   所以这条只在它存在时才验 —— committed 的测试不能硬依赖 untracked 的文件,
   否则任何人克隆下来跑一次就直接崩在 ENOENT 上。 */
const pgPath = path.join(__dirname, "_pagecheck.py");
if (!fs.existsSync(pgPath)) {
  console.log("  · 跳过 _pagecheck.py 的检查(本地文件,不在仓库里)");
} else
check("_pagecheck.py 里不再请求 /compare.html(否则它会 404)",
      !fs.readFileSync(pgPath, "utf8")
        .includes("/compare.html"));
check("根目录的 _fittest.js 副本已删除(同一份测试留两份必然分叉)",
      !fs.existsSync(path.join(__dirname, "_fittest.js")));
check('默认视觉档位是 A(用户选的那一档)',
      /localStorage\.getItem\("gstyle"\) \|\| "A"/.test(ajs),
      "默认还是 B —— 对比页都删了,用户永远选不回 A");
check("GraphStyles.B / .C 仍然在(fittest 用它们的 nameSize 跑贴合、用 B 验边序)",
      !!GraphStyles.B && !!GraphStyles.C &&
      GraphStyles.B.nameSize !== GraphStyles.A.nameSize,
      "删了要重写一整批贴合用例,不值");

console.log("\n人物卡分段");
{
  const appjs = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");
  const segs = [...appjs.matchAll(/data-seg="([a-z]+)" role="tab"/g)].map(m => m[1]);
  check(`分段按钮有 ${segs.length} 个`, segs.length === 3, segs.join(","));
  // 按钮的 data-seg 必须都能在内容区找到对应的面板,否则点了是一片空白
  for (const k of segs) {
    check(`「${k}」这一段有对应的内容面板`,
          new RegExp(`<div data-seg="${k}">`).test(appjs));
    check(`「${k}」这一段在 CSS 里有显示规则`,
          css.includes(`.seg-body[data-on="${k}"] > [data-seg="${k}"]`));
  }
  check("默认展开的那段是存在的",
        segs.includes((appjs.match(/class="seg-body" data-on="([a-z]+)"/) || [])[1]));
  check("openSheet 之后会接上分段的事件委托",
        /openSheet[\s\S]{0,220}bindSegs\(body\)/.test(appjs));
}

console.log("\n生成的 HTML 片段");
{
  const appjs = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");
  /* 同一个标签上出现两个 class 属性时,浏览器**只认第一个**,后面的静默失效。
     把内联样式批量换成类名时极容易撞上(元素本来就有 class)。
     这类错误页面不会报任何错,只是样式没生效,肉眼几乎看不出来。 */
  const dup = [...appjs.matchAll(/<[a-z]+ [^>]*class="[^"]*"[^>]*class="/g)];
  check(`没有重复的 class 属性(发现 ${dup.length} 处)`, dup.length === 0,
        "浏览器只认第一个 class,后面那个等于没写");

  const dupStyle = [...appjs.matchAll(/<[a-z]+ [^>]*style="[^"]*"[^>]*style="/g)];
  check(`没有重复的 style 属性(发现 ${dupStyle.length} 处)`, dupStyle.length === 0);
}

console.log("\n页面缩放:能做的和做不到的");
{
  /* iOS Safari 从 iOS 10 起故意忽略 user-scalable=no,所以只能靠 CSS 锁。
     真机上出现过整页被放大平移、顶栏的圈子名和整条底栏被挤出屏幕。 */
  const c = css.replace(/\/\*[\s\S]*?\*\//g, "");
  /* 我一开始给 html/body 写了 position:fixed + overflow:hidden 想锁住缩放 ——
     **无效**:iOS 的双指缩放平移的是视觉视口,这两个属性只管布局视口。
     而且把 <html> 变成固定定位是非常规写法,真机上引入了新的错位。已撤回。 */
  check("没有给 html/body 写 position:fixed(对视觉视口无效,反而有副作用)",
        !/html,body\{[^}]*position:fixed/.test(c));
  check("关掉双击缩放(touch-action:manipulation)",
        /html,body\{[^}]*touch-action:manipulation/.test(c));
  /* manipulation 等价于 pan-x pan-y pinch-zoom —— **它允许双指缩放**,只挡双击。
     我一开始以为它能挡住捏合,错了。能挡的是 none 或 pan-y。 */
  check("顶栏底栏用 none(它们从不滚动,双指落这儿不该缩放整页)",
        /#topbar,#tabbar[^{]*\{[^}]*touch-action:none/.test(c));
  check("需要滚动的容器用 pan-y(纵向滚动照旧,捏合被吃掉)",
        /#aibar,\.pad,\.sheet-body,#circleMenu\{touch-action:pan-y\}/.test(c));
  check("#stage 仍然是 touch-action:none(图谱要自己处理捏合)",
        /#stage\{[^}]*touch-action:none/.test(c),
        "改成 manipulation 的话图谱的双指缩放会被浏览器抢走");
}

console.log("\n给 dialog 写了 display 就必须补 :not([open])");
{
  /* <dialog> 关闭时靠默认样式表的 dialog:not([open]){display:none} 隐藏,
     而任何类/id 选择器写的 display 都会盖掉它 —— 于是一个 position:fixed
     的透明层永远铺在页面上,吞掉所有点击、拖动和滚动,页面看起来完全正常。
     这个坑我踩过一次,真机上表现为"什么都点不动"。 */
  const dialogIds = ["sheet", "toast"];
  for (const id of dialogIds) {
    const sel = id === "sheet" ? "\\.sheet" : "#" + id;
    const setsDisplay = new RegExp(sel + "\\{[^}]*display:", "").test(css);
    if (!setsDisplay) { check(`${id}: 没给 dialog 写 display,无需补规则`, true); continue; }
    check(`${id}: 写了 display,也补了 :not([open]){display:none}`,
          new RegExp(sel + "(:not\\(\\[open\\]\\))\\{display:none\\}").test(css)
          || new RegExp(sel.replace("\\.", "\\.") + ":not\\(\\[open\\]\\)\\{display:none\\}").test(css),
          "关闭状态下它会铺满视口吞掉所有交互");
  }
}

console.log("\n卡片在 iOS 上不能被工具栏吃掉");
{
  const html = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");
  const appjs = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");
  /* 直接给 dialog 写 bottom:0 时,iOS Safari 的固定定位底边在浏览器工具栏
     **下面** —— 卡片一大截藏在工具栏后,只露出顶上一条(真机上复现过)。 */
  check("dialog 是铺满视口的容器,卡片是内层 .sheet-card",
        /<div class="sheet-card">/.test(html));
  check("容器高度用 svh 而不是 dvh/bottom:0",
        /\.sheet\{[^}]*height:100svh/.test(css),
        "svh 是浏览器工具栏展开时的视口高度,也就是最小的那个");
  check("有 svh 不支持时的回退(iOS 15.4 没有 svh)",
        /@supports not \(height: 100svh\)/.test(css));
  check("容器把卡片顶到底边",
        /\.sheet\{[^}]*justify-content:flex-end/.test(css));
  check("卡片自己不再固定定位(定位交给容器)",
        !/\.sheet-card\{[^}]*position:fixed/.test(css));
  check("拖动写的是卡片的 transform,不是容器的",
        /card\.style\.transform = `translateY/.test(appjs));
  check("动画挂在卡片上", /\.sheet\[open\] \.sheet-card\{animation:rise/.test(css));
}

console.log("\n交叉复核抓到的四处接缝(修完要守住)");
{
  const html = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");
  const appjs = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");
  const gjs = fs.readFileSync(path.join(__dirname, "web", "graph.js"), "utf8");

  /* P1 卡片用 showModal() 之后在 top layer,普通元素的 z-index 再高也盖不住。
     19 处 toast 是在卡片开着时触发的,其中包括替代 confirm() 的那个「撤销」——
     看不见也点不到,等于删关系没有任何护栏。 */
  /* 第一版修法是把 #toast 也做成 <dialog> 用 .show() —— **不成立**:
     非模态的 show() 并不进 top layer(只有 showModal() 才进),而且模态卡片
     会把外面一切设为 inert,看得见也点不动。真机上验证过,撤销依旧不可见。
     可行的做法是显示前把它搬进那个打开着的 dialog。 */
  check("toast 显示前会按卡片是否打开决定挂在哪",
        /function showToast[\s\S]{0,300}dlg\.open\) \? dlg : document\.body[\s\S]{0,120}appendChild/.test(appjs),
        "留在 body 里的话,卡片开着时它既被盖住也点不动");
  check("卡片关闭时把 toast 搬回 body(否则它会跟着 dialog 一起消失)",
        /parentNode === dlg\) document\.body\.appendChild/.test(appjs));
  // 先剥掉注释 —— 上面那段说明里就写着 "overflow:hidden" 这几个字,
  // 直接对着原文匹配会把注释当成声明(我第一次就是这么写错的)
  const cssNoComment = css.replace(/\/\*[\s\S]*?\*\//g, "");
  check("卡片容器没有 overflow:hidden(会裁掉搬进来的 toast)",
        !/\.sheet\{[^}]*overflow:hidden/.test(cssNoComment));
  check("#toast 是普通元素,不是 dialog",
        /<div id="toast"/.test(html),
        "做成 dialog 反而更糟:show() 不进 top layer");

  /* P2 父元素的 color:transparent 只靠继承传给后代,而任何自有声明都赢过
     继承值 —— .tag.warn 自己写了 color,打码后色带上照样印着真名。 */
  check("打码覆盖到 .blurable 的后代(否则 .tag.warn 里的真名照样能读)",
        /body\.masked \.blurable \*\{color:transparent !important\}/.test(css));
  check("AI 审核里「合并进「某某」」带 blurable",
        /class="blurable">合并进/.test(appjs));

  /* P3 批8 的性能降级会在 >160 条边时关掉流光渐变,而批2 的"一头青一头红"
     全部实现在渐变里 —— 合起来的后果是混合边在最需要区分的规模上退化成
     纯红实线,图例却还在承诺双色。 */
  check("混合边无视 streak 降级,始终走渐变",
        /\(style\.streak \|\| mix\)/.test(gjs));
  check("关掉流光时仍为混合边发射渐变",
        /if \(e\.mixed\) out\.push\(streakDef/.test(gjs));

  /* P4 render() 只换 innerHTML 不动 classList,于是 focused 留在旧状态、
     新 DOM 里一个 .near/.sel 都没有 → 全图 opacity .14,整张图发暗。 */
  check("render 换数据时清掉 focused / hovering",
        /svg\.innerHTML = GraphRender\.buildSVG[\s\S]{0,400}classList\.remove\("focused", "hovering"\)/.test(gjs));
}

console.log("\n卡片迁到原生 <dialog>");
{
  const html = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");
  const appjs = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");

  check("#sheet 是 <dialog> 而不是 <div>",
        /<dialog id="sheet"/.test(html), "还是老的浮层实现");
  check("头部(把手 + 关闭)在滚动容器外面",
        /<div class="sheet-head">[\s\S]*?<\/div>\s*<!--[\s\S]*?-->\s*<div class="sheet-body"/.test(html)
        || html.indexOf('class="sheet-head"') < html.indexOf('class="sheet-body"'),
        "关闭按钮会随内容滚走 —— 人物卡很长,滚两屏就找不到 ✕ 了");

  /* showModal() 对已经打开的 dialog 会抛 InvalidStateError,而
     "人物卡里点一条关系 → 打开连线卡" 正是在已开状态下调的。
     少了这个判断,点关系行会直接报错。 */
  check("showModal 前判断了 dlg.open(否则重入会抛 InvalidStateError)",
        /if\s*\(!dlg\.open\)\s*\{[\s\S]{0,220}?showModal\(\)/.test(appjs));

  check("关闭走动画后再 close(退场不再是瞬间消失)",
        /classList\.add\("closing"\)[\s\S]{0,160}animationend/.test(appjs));
  check("close 事件里统一做清理(所有关闭路径汇到一处)",
        /addEventListener\("close"/.test(appjs));
  check("点遮罩能关闭(e.target === dlg 时命中的就是 ::backdrop)",
        /e\.target === dlg/.test(appjs));
  check("把手真的绑了下拉手势(以前画了个把手却什么都不做)",
        /sheet-head[\s\S]{0,600}touchmove/.test(appjs));
  check("boot 里调用了 bindSheet", /bindSheet\(\);/.test(appjs));

  check("::backdrop 有压暗(深色下卡片和背景分层全靠它)",
        /\.sheet::backdrop\{[^}]*background/.test(css));
  check("深色下有顶缘高光线,浅色下关掉",
        /\.sheet-card::before\{/.test(css) &&
        /\[data-theme="light"\] \.sheet-card::before\{display:none\}/.test(css));
  check("滚动容器有 overscroll-behavior:contain(否则滚到底会带动整页)",
        /\.sheet-body\{[^}]*overscroll-behavior:contain/.test(css));

  check("正文里不再自带把手和关闭按钮(已经在静态结构里了)",
        !/sheet-grab/.test(appjs) && !appjs.includes('class="close"'),
        "会出现两个 ✕");
}

console.log("\n图标雪碧图");
/* <use href="#i-x"> 引到一个不存在的 symbol 时,SVG 什么都不画,也不报错 ——
   按钮会变成一块空白,而且只有肉眼才看得出来。所以这里静态核对一遍。 */
{
  const html = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");
  const appjs = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8");
  const defined = new Set(
    [...html.matchAll(/<symbol id="(i-[a-z]+)"/g)].map(m => m[1]));
  // 既要匹配静态的 href="#i-x",也要匹配 JS 里 setAttribute 用的 "#i-x"
  const used = new Set(
    [...(html + appjs).matchAll(/["']#(i-[a-z]+)["']/g)].map(m => m[1]));

  const missing = [...used].filter(u => !defined.has(u));
  check(`每个 <use> 都有对应的 symbol(用到 ${used.size} 个)`,
        missing.length === 0, "引了但没定义:" + missing.join(", "));

  const unused = [...defined].filter(d => !used.has(d));
  check(`没有定义了却没人用的图标(共 ${defined.size} 个)`,
        unused.length === 0, "多余的:" + unused.join(", "));

  // 换 emoji 的主要目的就是让 .icon-btn.on 的强调色能生效
  check("图标用 currentColor 描边(否则 .icon-btn.on 的强调色不起作用)",
        /\.ic\{[^}]*stroke:currentColor/.test(css));

  check("顶栏和底栏里已经没有 emoji 图标了",
        !/<i>[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html),
        "还有 <i>emoji</i> 残留 —— 彩色 emoji 忽略 CSS 的 color");

  // boot() 会取顶栏按钮,index.html 删了按钮而 app.js 没改 = 整个应用白屏
  for (const id of ["themeBtn", "fitBtn", "maskBtn", "circleBtn"]) {
    check(`#${id} 在 index.html 和 app.js 里都存在`,
          html.includes(`id="${id}"`) && appjs.includes(`#${id}`));
  }
  check("app.js 里没有对已移除的 #facBtn 的引用(有的话 boot 会抛异常白屏)",
        !appjs.includes("facBtn"));
  check("派系着色的开关搬到了设置页并绑上了",
        appjs.includes('id="facSw"') && appjs.includes('$("#facSw").onchange'));
}

console.log("\n底栏的四个 tab(专挡「加了 tab 忘了加 section」这类致命低级错)");
/* 加一个 tab 要同时动三个文件:index.html 的 <button data-view>、
   index.html 的 <section id="view-X">、app.js 的 switchView 分支。
   漏掉 section:switchView 里 $("#view-X") 是 null → `null.classList` 抛异常,
   而它是在点击处理器里抛的,整个底栏从此点哪个都没反应。
   漏掉 switchView 分支:页面能翻出来,但永远是空白的。
   两种都不报可见的错,肉眼只看得到「点了没用」。 */
{
  const htmlNav = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");
  const navs = [...htmlNav.matchAll(/<button class="navbtn[^"]*" data-view="([a-z]+)"/g)]
    .map(m => m[1]);
  check(`.navbtn 恰好 4 个(${navs.join(" / ")})`, navs.length === 4,
        "数量对不上:" + navs.length);

  // switchView 的函数体:从 function switchView 到下一个顶格的 }
  const sw = ajs.slice(ajs.indexOf("function switchView"),
                       ajs.indexOf("\n}", ajs.indexOf("function switchView")));
  for (const v of navs) {
    check(`data-view="${v}" 有对应的 <section id="view-${v}">`,
          new RegExp(`<section class="view[^"]*" id="view-${v}"`).test(htmlNav),
          "switchView 里会 null.classList,整个底栏从此点不动");
    check(`switchView 里有 ${v} 的分支`,
          new RegExp(`name === "${v}"`).test(sw),
          "这一页翻得出来,但永远是空白");
  }
  // 反过来也要成立:有 section 却没 tab 的页面永远打不开
  const secs = [...htmlNav.matchAll(/<section class="view[^"]*" id="view-([a-z]+)"/g)]
    .map(m => m[1]);
  const orphan = secs.filter(s => !navs.includes(s));
  check(`每个 view section 都有 tab 能到达(${secs.length} 个)`,
        orphan.length === 0, "打不开的:" + orphan.join(", "));

  check("「局势」排第二(频率仅次于图谱)", navs[1] === "situation", navs.join(","));
  check("「设置」留在最右(最不常用 + 大屏手机最难够到的角)",
        navs[navs.length - 1] === "settings", navs.join(","));

  /* 四个 tab 零 CSS 改动就装得下,靠的就是 flex:1(iPhone SE 320px 上各 80px)。
     谁要是给 .navbtn 加了固定宽度,四个立刻挤爆或者溢出。 */
  check(".navbtn 仍然是 flex:1(第四个 tab 能不能装下全靠它)",
        /\.navbtn\{[^}]*flex:1/.test(css));
  check("桌面档仍然是 flex:0 0 130px 居中(4×130=520,放得下)",
        /\.navbtn\{flex:0 0 130px\}/.test(css));

  /* 局势页只发这一个接口,而且**不能**跟 /api/graph 搭车 ——
     后者冷启动 2.1 秒、每次 resize 和切圈子都重发。
     只看代码不看注释:这份文件的注释本身就在讨论这件事。 */
  const noComment = ajs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  check("局势页只发 GET /api/analysis/situation 这一处",
        (noComment.match(/\/api\/analysis\/situation/g) || []).length === 1,
        "多出来的多半是跟 /api/graph 一起取了");
  check("局势数据不是搭 /api/graph 的车回来的",
        !/graph\?[^"`]*situation|situation[^"`]*graph\?/.test(noComment));

  /* 缓存键必须同时含 graph_version 和圈子 id。
     少了 version:改完一条关系再看局势还是旧的,而这一页正是拿来做决定的。
     少了圈子 id:公司圈的矛盾会印在同学圈上。 */
  check("局势缓存的键用上了 graph_version(/api/state 早就返回、前端一直没用的字段)",
        /function sitKey\(\)[\s\S]{0,200}graph_version[\s\S]{0,120}S\.circle/.test(ajs),
        "键里缺了 version 或圈子 id");
  check("慢请求回来会重新核对键(切圈子后不会把上一个圈子的局势印上去)",
        /sitKey\(\) !== key/.test(noComment));
  check("换圈子后局势页会跟着重算",
        /S\.view === "situation"\) renderSituation/.test(
          ajs.slice(ajs.indexOf("async function switchCircle"))));

  /* /api/analysis/situation 是个**会写库的 GET**(没命中就 db.cache_put),
     而 db 是全进程一个 sqlite 连接、tx() 在共享连接上直接 commit()。
     两个并发进来,一个线程的 commit 会把另一个线程写了一半的事务一起提交 ——
     写路径那六个函数都上了同一种闸,读路径这一个也不能开例外。 */
  const rs = ajs.slice(ajs.indexOf("async function renderSituation"),
                       ajs.indexOf("\n}", ajs.indexOf("async function renderSituation")));
  check("局势请求上了串行闸(它是个会写库的 GET)",
        /if \(sitBusy\) return;/.test(rs) && /sitBusy = true;/.test(rs) &&
        /finally \{\s*\n\s*sitBusy = false;/.test(rs),
        "两个并发会撞上同一个 sqlite 连接的 commit");
  check("被闸挡下的那次不会被丢掉(落地后按新键补一次)",
        /sitKey\(\) !== key\) renderSituation\(\)/.test(rs));
  check("重画前先比键,不白白清掉名册的展开状态和滚动位置",
        /box\.dataset\.key === key\) return;/.test(rs));
}

console.log("\n设计 token 体系(防止改回散装数值)");
/* 这几条不是"风格洁癖"。半像素字号在 Windows 上会被字体舍入,
   造成"看起来没对齐但说不出哪里不对";而 --fs-form 低于 16px 会让
   iOS Safari 在聚焦输入框时强制放大整页 —— 那是功能性 bug。 */
{
  const decl = [...css.matchAll(/font-size:\s*([0-9.]+)px/g)].map(m => m[1]);
  const halves = decl.filter(v => !Number.isInteger(+v));
  check(`没有半像素字号(发现 ${halves.length} 处)`, halves.length === 0,
        "散装的 11.5/12.5/13.5 又回来了:" + halves.join(", "));

  const m = css.match(/--fs-form:\s*(\d+)px/);
  check("--fs-form 是 16px(低于它 iOS 聚焦输入框会放大整页)",
        m && +m[1] >= 16, m ? `实际 ${m[1]}px` : "token 不见了");

  check("AI 输入框用的是 --fs-form,不是别的档",
        /#aiInput\{[^}]*font:\s*var\(--fs-form\)/.test(css),
        "它是全 app 最常用的输入框,字号一低就会触发 iOS 缩放");

  check("字重里没有 650(PingFang/YaHei 没有这一字面,和 600 渲染完全一致)",
        !/font-weight:\s*650/.test(css));

  // 只看规则体,不看 :root 里的 token 声明本身(--r-pill:999px 是定义不是用法)
  const rules = css.slice(css.indexOf("*{box-sizing"));
  const radii = [...rules.matchAll(/border-radius:\s*([0-9]+)px/g)].map(m => m[1]);
  check(`圆角都走 token(还剩 ${radii.length} 个裸值)`, radii.length === 0,
        "裸圆角:" + radii.join(", "));

  check(".icon-btn 的热区至少 40×40",
        /\.icon-btn\{[^}]*width:40px[^}]*height:40px/.test(css),
        "顶栏按钮以前是 34×28,手机上很容易点错旁边那个");
}

const html = fs.readFileSync(path.join(__dirname, "web", "index.html"), "utf8");

console.log("\n画边的字符串全项目只能有一份(增量补丁最大的风险点)");
/* 手动加一条关系之后前端**只补一条边**,不重排整张图。补丁走的是
   GraphRender.edgeMarkup / streakDef,全量渲染的 buildSVG 也必须走同一份 ——
   两份实现是这个功能最容易出、又最难看出来的错:补出来的边和刷新之后的边
   长得不一样,而两者永远不会同时出现在屏幕上。这一条恰好能纯 node 验。 */
{
  for (const st of [GraphStyles.A, GraphStyles.B, GraphStyles.C]) {
    const svgStr = GraphRender.buildSVG(PL, st);
    const joined = PL.edges.map(e => GraphRender.edgeMarkup(e, st, "")).join("");
    check(`${st.name}:buildSVG 的边区逐字节等于 edgeMarkup 的拼接`,
          svgStr.includes(joined),
          "buildSVG 里还留着一份自己拼的边 —— 增量补丁迟早和它对不上");
    const miss = PL.edges.filter(e =>
      !svgStr.includes(GraphRender.edgeMarkup(e, st, "")));
    check(`${st.name}:逐条核对(${PL.edges.length} 条,缺 ${miss.length} 条)`,
          miss.length === 0,
          miss.slice(0, 3).map(e => `${e.a}-${e.b}`).join(", "));
    if (st.streak) {
      const defs = PL.edges.map(e => GraphRender.streakDef(e, "")).join("");
      check(`${st.name}:流光渐变也只有一份`, svgStr.includes(defs),
            "defs 里那份和 streakDef 对不上,补出来的边会引到一个不存在的渐变");
    }
  }
  // 补丁和全量必须用同一个 idPrefix(空),否则 url(#e1_2) 引到不存在的渐变 ——
  // 线会整条不可见,而且不报任何错
  check("render() 和 upsertEdge 都不带 idPrefix(带了就会引到别处的渐变)",
        /GraphRender\.buildSVG\(payload, style\)/.test(gjs) &&
        /GraphRender\.edgeMarkup\(e, rstyle, ""\)/.test(gjs) &&
        /GraphRender\.streakDef\(e, ""\)/.test(gjs));

  /* 同一个道理的另一半:流光会**按边数降级**(见 effectiveStyle)。
     整图渲染关掉了流光,而增量补丁那条还开着的话,补出来的边会去引一个
     defs 里根本不存在的渐变 —— 线整条不可见,不报错。
     所以画边的三处必须读同一个降级后的 rstyle,而不是用户选的 style。 */
  check("upsertEdge 用的是降级后的 rstyle,不是原始的 style",
        /if \(rstyle\.streak\)/.test(gjs) &&
        !/GraphRender\.edgeMarkup\(e, style,/.test(gjs),
        "补出来的边会和整图的流光开关对不上");
  check("render() 把 effectiveStyle 的结果存进了 rstyle",
        /rstyle = GraphRender\.effectiveStyle\(style, payload\)/.test(gjs));
  {
    // 真的跑一遍:边数跨过阈值前后,buildSVG 里的 stroke 写法必须跟着变
    const few = { ...PL, edges: PL.edges.slice(0, 5) };
    const many = { ...PL,
      edges: Array.from({ length: GraphRender.STREAK_MAX_EDGES + 1 },
        (_, i) => ({ ...PL.edges[0], a: 1000 + i, b: 2000 + i })) };
    const sFew = GraphRender.buildSVG(few, GraphStyles.A);
    const sMany = GraphRender.buildSVG(many, GraphStyles.A);
    check(`边少时流光开着(${few.edges.length} 条 ≤ ${GraphRender.STREAK_MAX_EDGES})`,
          sFew.includes("<linearGradient") && /stroke="url\(#e/.test(sFew));
    check(`边多时流光整个关掉(${many.edges.length} 条 > ${
            GraphRender.STREAK_MAX_EDGES},省下约 ${many.edges.length * 5} 个 DOM 节点)`,
          !sMany.includes("<linearGradient") && !/stroke="url\(#e/.test(sMany) &&
          /stroke="var\(--/.test(sMany),
          "381 条边 × 5 个节点 = 1905 个 DOM,而那个尺度上根本看不见两端淡出");
    check("降级不会改坏 GraphStyles.A 本身(它是全局共享的常量)",
          GraphStyles.A.streak === true);
  }
}

console.log("\n前端的 pairAggregate 与服务端逐条一致");
/* 期望值是用 python 跑**真实管线**导出来的(db.upsert_relation →
   analysis.build_graph → layout.get_graph_payload),不是我在这里重算一遍。
   覆盖:混合关系、max 平局取第一个、钳 ±3、w==0 且非混合时边应当消失。

   最要命的是平局:**Python 的 max/min 平局取第一个,所以 JS 里必须写 >
   不能写 >=**。「非混合·平局取第一个」和「非混合·平局反序」这两条就是
   专为它准备的 —— 写成 >= 时两条会同时翻。 */
const GLYPH = { "情感": "♥", "利益": "¥", "职场": "▪",
                "社交": "●", "学缘": "✎", "亲缘": "⌂" };
const PAIRS = [
  ["单条正向", [{k:"朋友",s:2,c:"社交"}], {w: 2, pw: 2, nw: 0, label: "朋友", glyph: "●", count: 1, mixed: false, width: 1.74}],
  ["单条负向", [{k:"敌对",s:-3,c:"社交"}], {w: -3, pw: 0, nw: -3, label: "敌对", glyph: "●", count: 1, mixed: false, width: 2.21}],
  ["同号相加", [{k:"朋友",s:2,c:"社交"},{k:"点头之交",s:0,c:"社交"},{k:"同事",s:1,c:"职场"}], {w: 3, pw: 3, nw: 0, label: "朋友", glyph: "●", count: 3, mixed: false, width: 2.21}],
  ["正向钳到+3", [{k:"死党",s:3,c:"社交"},{k:"家人",s:3,c:"亲缘"},{k:"情侣",s:3,c:"情感"}], {w: 3, pw: 3, nw: 0, label: "死党", glyph: "●", count: 3, mixed: false, width: 2.21}],
  ["负向钳到-3", [{k:"敌对",s:-3,c:"社交"},{k:"宿怨",s:-3,c:"社交"}], {w: -3, pw: 0, nw: -3, label: "敌对", glyph: "●", count: 2, mixed: false, width: 2.21}],
  ["混合·负占优", [{k:"同事",s:1,c:"职场"},{k:"竞争",s:-2,c:"利益"}], {w: -1, pw: 1, nw: -2, label: "同事 / 竞争", glyph: "⚡", count: 2, mixed: true, width: 1.74}],
  ["混合·恰好抵消", [{k:"朋友",s:2,c:"社交"},{k:"竞争",s:-2,c:"利益"}], {w: 0, pw: 2, nw: -2, label: "朋友 / 竞争", glyph: "⚡", count: 2, mixed: true, width: 1.74}],
  ["混合·正占优", [{k:"死党",s:3,c:"社交"},{k:"竞争",s:-1,c:"利益"}], {w: 2, pw: 3, nw: -1, label: "死党 / 竞争", glyph: "⚡", count: 2, mixed: true, width: 2.21}],
  ["混合·平局取第一个", [{k:"朋友",s:2,c:"社交"},{k:"合作",s:2,c:"利益"},{k:"竞争",s:-2,c:"利益"}], {w: 2, pw: 3, nw: -2, label: "朋友 / 竞争", glyph: "⚡", count: 3, mixed: true, width: 2.21}],
  ["非混合·平局取第一个", [{k:"朋友",s:2,c:"社交"},{k:"合作",s:2,c:"利益"}], {w: 3, pw: 3, nw: 0, label: "朋友", glyph: "●", count: 2, mixed: false, width: 2.21}],
  ["非混合·平局反序", [{k:"合作",s:2,c:"利益"},{k:"朋友",s:2,c:"社交"}], {w: 3, pw: 3, nw: 0, label: "合作", glyph: "¥", count: 2, mixed: false, width: 2.21}],
  ["有向关系不影响聚合", [{k:"上下级",s:1,c:"职场"},{k:"师徒",s:2,c:"职场"}], {w: 3, pw: 3, nw: 0, label: "师徒", glyph: "▪", count: 2, mixed: false, width: 2.21}],
  ["纯中性·边应当消失", [{k:"点头之交",s:0,c:"社交"}], null],
  ["多条中性·边应当消失", [{k:"点头之交",s:0,c:"社交"},{k:"金钱借贷",s:0,c:"利益"}], null],
];
for (const [title, rels, want] of PAIRS) {
  const got = GraphRender.pairAggregate(
    rels.map(r => ({ kind: r.k, strength: r.s, cat: r.c })), GLYPH);
  if (!want) {
    check(`${title}`, got.visible === false,
          `前端算出 w=${got.w} mixed=${got.mixed},服务端根本不画这条边`);
    continue;
  }
  const diff = Object.keys(want).filter(k => got[k] !== want[k]);
  check(`${title}(w=${want.w} ${want.label})`, got.visible === true && !diff.length,
        diff.map(k => `${k}: 前端 ${JSON.stringify(got[k])} ≠ 服务端 ${
          JSON.stringify(want[k])}`).join(" / ") || "visible 应当为真");
}

console.log("\n增量补丁的纯计算部分");
{
  const NODES = { 3: { x: 100, y: 200 }, 9: { x: 400.44, y: 20.06 } };
  const agg = GraphRender.pairAggregate(
    [{ kind: "朋友", strength: 2, cat: "社交" }], GLYPH);
  const e1 = GraphRender.edgeFromPair(9, 3, agg, id => NODES[id], 50);
  const e2 = GraphRender.edgeFromPair(3, 9, agg, id => NODES[id], 50);
  // 服务端的 pair_kinds 键是 (min,max),前端反着传也必须落到同一条边上,
  // 否则同一对人会出现两条 <g class="eg">,而且互相盖着看不出来
  check("edgeFromPair 把键归一成 (min,max)",
        e1.a === 3 && e1.b === 9 && JSON.stringify(e1) === JSON.stringify(e2),
        `得到 ${e1.a}-${e1.b} 和 ${e2.a}-${e2.b}`);
  check("端点坐标按服务端的 round(x,1) 取整",
        e1.x1 === 100 && e1.y1 === 200 && e1.x2 === 400.4 && e1.y2 === 20.1,
        `${e1.x1},${e1.y1} → ${e1.x2},${e1.y2}`);
  const q = GraphRender.arc(100, 200, 400.44, 20.06, 50);
  check("控制点和标签落点走的还是那一套 arc()",
        e1.cx === Math.round(q.cx * 10) / 10 &&
        e1.cy === Math.round(q.cy * 10) / 10 &&
        e1.mx === Math.round(q.qx * 10) / 10 &&
        e1.my === Math.round(q.qy * 10) / 10);
  // 补出来的边必须能直接喂给 edgeMarkup —— 少一个字段就画出个 undefined
  const mk = GraphRender.edgeMarkup(e1, GraphStyles.A, "");
  check("补出来的边对象喂给 edgeMarkup 不会缺字段",
        !/undefined|NaN/.test(mk), mk.slice(0, 160));

  check("GraphView 导出了 upsertEdge / removeEdge",
        /upsertEdge/.test(gjs) && /removeEdge/.test(gjs) &&
        /return \{[^}]*upsertEdge, removeEdge \};/.test(gjs.replace(/\n/g, " ")),
        "app.js 调不到就只能整张重排了");
  check("GraphRender 导出了 edgeMarkup / streakDef / pairAggregate",
        ["edgeMarkup", "streakDef", "pairAggregate", "pairKey", "edgeFromPair"]
          .every(k => typeof GraphRender[k] === "function"));

  /* moveNode 会把拖动中的位置写回 payload 的 n.x/n.y。增量补丁后重建索引时
     若还无条件按 n.x 重置 pos,ox(算法排好的原位)就被污染成拖后的位置,
     松手再也飘不回去 —— 而这只有真机拖一下才看得出来。 */
  check("buildIndex 收 keepPos,且补丁路径传的是 true",
        /function buildIndex\(payload, keepPos\)/.test(gjs) &&
        (gjs.match(/buildIndex\(data, true\)/g) || []).length >= 2,
        "keepPos 没了的话,补一条边就会把拖动的原位擦掉");
}

console.log("\n手动录入(加人 / 加关系 / 改强度 / 记一笔)");
{
  /* STRENGTH_LABEL 是从源码里抠出来求值的 —— app.js 依赖 document,
     node 里 require 不进来。滑块能滑到 0,少一档就会显示「0 undefined」。 */
  const lit = ajs.match(/const STRENGTH_LABEL = \{([\s\S]*?)\};/);
  const LB = lit ? new Function("return {" + lit[1] + "}")() : {};
  const holes = [-3, -2, -1, 0, 1, 2, 3].filter(v => !LB[v]);
  check(`STRENGTH_LABEL 覆盖 -3..3 全部 7 档(缺 ${holes.length} 档)`,
        holes.length === 0, "缺:" + holes.join(", "));

  check("强度滑块的量程就是 -3..3",
        /type="range" id="relStr" min="-3" max="3" step="1"/.test(ajs));

  /* 快路径的守门人:两个已有节点之间加边**只补一条边,布局一动不动**。
     S.graphLoaded = false 一旦跑到 if 外面,每存一条关系就整张重排,
     功能看起来完全正常,只是每次都要等半秒、所有球都跳一下。 */
  const body = s => {
    const i = ajs.indexOf(s);
    return i < 0 ? "" : ajs.slice(i, ajs.indexOf("\n}", i));
  };
  const sync = body("async function syncPairEdge");
  check("增量补丁走了 GraphView.upsertEdge",
        /const patched = S\.graphLoaded && GraphView\.upsertEdge/.test(sync));
  check("S.graphLoaded = false 只在 else 分支里(否则快路径名存实亡)",
        /if \(patched\) \{[\s\S]*?\} else \{\s*\n\s*S\.graphLoaded = false;/.test(sync) &&
        (sync.match(/S\.graphLoaded = false/g) || []).length === 1,
        "它跑到 if 外面了 —— 每存一条关系都会整张重排");
  check("saveRelation 自己不碰 S.graphLoaded(统一交给 syncPairEdge)",
        !/S\.graphLoaded = false/.test(body("async function saveRelation")));
  check("复位键是重新排布的显式出口(有补丁时才重排,绝不偷偷排)",
        /S\.patched/.test(ajs) && /#fitBtn"\)\.onclick[\s\S]{0,400}S\.patched/.test(ajs));

  // 「改」和「换类型」必须彻底分开:upsert 的键是 (circle,a,b,kind),
  // 换 kind 是 INSERT 而旧的还在,聚合会把两条一起算
  check("「改」锁死类型(edit 模式下根本不渲染类型 chip)",
        /const locked = F\.mode === "edit"/.test(ajs) &&
        /\$\{lockBox \|\| `/.test(ajs));
  check("「换类型」挂了 warnbox 说明是删一条建一条",
        /F\.mode === "swap" \? `[\s\S]{0,80}warnbox/.test(ajs));
  const sr = body("async function saveRelation");
  check("换类型是**先建后删**(中途失败留两条,好过留零条)",
        sr.indexOf('api("/api/relations", {') >= 0 &&
        sr.indexOf('api("/api/relations", {') <
          sr.indexOf('api("/api/relations/delete"'),
        "顺序反了:先删后建,中途失败这条关系就没了");

  check("删除改成「撤销」toast,不再 confirm",
        !/confirm/.test(body("async function delRelation")) &&
        /toastUndo\(/.test(ajs));

  /* 每个写路径都得上串行闸。#busy 那层遮罩在这儿指望不上:卡片是 <dialog>,
     top layer 里的东西普通元素盖不住,连点两下第二下照样发得出去 ——
     而两个 POST 并发时,一个线程的 commit() 会把另一个线程写了一半的
     事务一起提交(全进程共用一个 sqlite 连接)。 */
  const noLatch = ["saveRelation", "savePerson", "saveEvent", "delRelation",
                   "undoDelRelation", "createPersonInline"]
    .filter(fn => {
      const b = body("async function " + fn);
      return !/if \(writing\) return;/.test(b) ||
             !/finally \{ writing = false; \}/.test(b);
    });
  check(`六个写路径都上了串行闸(漏 ${noLatch.length} 个)`, noLatch.length === 0,
        "漏的:" + noLatch.join(", "));

  /* 下面两条只看代码不看注释 —— 这份文件的注释本身就在讨论
     「不用原生 select」「绝不预热 /api/graph」,连注释一起数必然误报。 */
  const code = ajs.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  // 选人不能用原生 <select>:iOS 上 100 个 option 是只能盲滚的滚轮
  const selects = (code.match(/<select/g) || []).length;
  check(`选人是自建下拉,原生 <select> 没有增加(${selects} 个:我是谁 + AI 审核两个)`,
        selects === 3 && /data-plist="\$\{slot\}"/.test(ajs) &&
        /data-new="1"/.test(ajs),
        "多出来的 <select> 多半是拿它当选人用了");
  check("「＋ 新建「XXX」」这一行就是加人入口",
        /data-new/.test(ajs) && /createPersonInline/.test(ajs));
  /* 人物页改成"只建一次、之后只翻 hidden"之后,搜索键预存进了 data-q,
     不再每次现拼。但它和选人面板搜的**必须是同一套字段** ——
     所以两处共用 searchKey(),而不是各写一份表达式。 */
  check("人物页和选人面板共用同一个 searchKey(不是各写一份过滤表达式)",
        /function searchKey\(p\)\s*\{\s*\n?\s*return \(p\.name \+ p\.dept \+ p\.title \+ p\.tags\)\.toLowerCase\(\);/.test(ajs) &&
        (ajs.match(/searchKey\(p\)/g) || []).length === 3 &&
        !/\(p\.name \+ p\.dept \+ p\.title \+ p\.tags\)\.toLowerCase\(\)\.includes\(q\)/.test(ajs),
        "两处不一样等于同一个词搜出两种结果,而用户只会以为是数据坏了");
  check("空查询按 updated_at 倒序(连着录十条时省打字)",
        /\(y\.updated_at \|\| 0\) - \(x\.updated_at \|\| 0\)/.test(ajs));
  check("默认展开的类别取自 circle_kinds(这个字段前端一直没用过)",
        /circle_kinds/.test(ajs) && /function defaultCat/.test(ajs));
  check("选中类型时强度自动跳到 kinds[k].default",
        /kindInfo\(k\)\.default/.test(ajs));
  check("方向 chip 用真名不用 A/B",
        /data-dir", "ab", `\$\{esc\(a\.name\)\} → \$\{esc\(b\.name\)\}`/.test(ajs));

  /* 明确不做后台预热 /api/graph:它是个会写库的 GET(_save_seed / cache_put),
     和用户的 POST 并发时,一个线程的 commit() 会把另一个线程写了一半的
     事务一起提交。全项目只有 loadGraph 一处发它。 */
  check(`/api/graph 全 app 只发一处(数到 ${
          (code.match(/\/api\/graph/g) || []).length} 处)`,
        (code.match(/\/api\/graph/g) || []).length === 1,
        "多出来的多半是后台预热 —— 那会和写操作抢同一个 sqlite 连接");

  // 五处入口一个都不能少
  for (const [label, re] of [
    ["AI 输入栏的 ＋", /id="aiPlus"/],
    ["人物页搜索框右侧的 ＋ 新建", /id="newPersonBtn"/],
    ["人物卡关系段头的 ＋", /data-seg="rel"[\s\S]{0,400}openRelForm\(\{a:/],
    ["连线卡的「＋ 再加一条」", /openRelForm\(\{a:\$\{a\},b:\$\{b\}\}\)/],
    ["连线卡每行的 改 \/ 换类型 \/ 删",
     /editRelation\(\$\{i\}\)[\s\S]{0,300}swapRelation\(\$\{i\}\)[\s\S]{0,300}delRelation\(\$\{i\}\)/],
  ]) {
    check(`入口:${label}`, re.test(ajs + html));
  }
}

console.log("\n表单真正渲染出来是什么样(纯 node 跑一遍 renderRelForm)");
/* 上面那些是源码正则,这一段是**真的把表单渲染一遍再看输出**。
   两者抓的不是一类错:模板里写着 `class="btn mini${on ? " primary" : ""}"`,
   源码正则永远看不见拼出来的结果里到底有几个 class、有没有 undefined、
   26 个类型是不是一次全铺出来了。这些在手机上都只是"看着怪",不报错。

   做法:把 graph.js + app.js 塞进一个 vm 上下文,DOM 用一个万能 Proxy 顶着,
   只把 innerHTML 的赋值记下来。location.protocol 设成 file: 让 boot() 立刻返回,
   一个网络请求都不会发。 */
{
  const vm = require("vm");
  const cap = {};
  const stub = sel => new Proxy(function () {}, {
    get(t, k) {
      if (k === "value") return "";
      if (k === "dataset") return {};
      if (k === "querySelector") return () => null;   // bindSegs 找不到 .seg 就退出
      if (k === "querySelectorAll") return () => [];
      if (k === "then") return undefined;             // 别被 await 当成 thenable
      if (k === Symbol.toPrimitive) return () => "";
      return stub(sel);
    },
    set(t, k, v) { if (k === "innerHTML") cap[sel] = String(v); return true; },
    apply() { return stub(sel); },
  });
  const ctx = {
    console, setTimeout, clearTimeout, JSON, Math, Date, Object, Array,
    String, Number, Boolean, RegExp, Promise, Error, parseFloat, parseInt,
    location: { protocol: "file:" },        // boot() 看到它就直接返回
    navigator: {}, window: { addEventListener() {} },
    localStorage: { getItem: () => null, setItem() {} },
    requestAnimationFrame: () => 0,
    fetch: () => Promise.reject(new Error("测试里不发网络请求")),
    document: {
      querySelector: stub, querySelectorAll: () => [],
      getElementById: () => stub("byid"), createElement: () => stub("el"),
      documentElement: stub("html"), body: stub("body"),
      addEventListener() {},
    },
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(gjs + "\n" + ajs +
    "\n;globalThis.__t = { S, F, renderRelForm, renderEventForm, situationHtml," +
    " formatTension, tensionHeadline, allyTier, allyRows, leadCount, ALLY_TIERS," +
    " LEAD_GAP };", ctx);
  const T = ctx.__t;

  // 词表照抄 db.py(RELATION_KINDS / CATEGORIES / CATEGORY_GLYPH / CIRCLE_KINDS)
  T.S.state = JSON.parse('{"kinds":{"情侣":{"cat":"情感","sign":1,"directed":0,"default":3},"暧昧":{"cat":"情感","sign":1,"directed":0,"default":2},"好感":{"cat":"情感","sign":1,"directed":1,"default":1},"单恋":{"cat":"情感","sign":1,"directed":1,"default":2},"前任":{"cat":"情感","sign":0,"directed":0,"default":0},"情敌":{"cat":"情感","sign":-1,"directed":0,"default":-2},"利益往来":{"cat":"利益","sign":1,"directed":0,"default":1},"合作":{"cat":"利益","sign":1,"directed":0,"default":2},"金钱借贷":{"cat":"利益","sign":0,"directed":1,"default":0},"竞争":{"cat":"利益","sign":-1,"directed":0,"default":-2},"利益冲突":{"cat":"利益","sign":-1,"directed":0,"default":-2},"上下级":{"cat":"职场","sign":0,"directed":1,"default":1},"同事":{"cat":"职场","sign":0,"directed":0,"default":1},"师徒":{"cat":"职场","sign":1,"directed":1,"default":2},"提携":{"cat":"职场","sign":1,"directed":1,"default":2},"派系盟友":{"cat":"职场","sign":1,"directed":0,"default":3},"朋友":{"cat":"社交","sign":1,"directed":0,"default":2},"死党":{"cat":"社交","sign":1,"directed":0,"default":3},"点头之交":{"cat":"社交","sign":0,"directed":0,"default":0},"敌对":{"cat":"社交","sign":-1,"directed":0,"default":-3},"宿怨":{"cat":"社交","sign":-1,"directed":0,"default":-3},"同学":{"cat":"学缘","sign":0,"directed":0,"default":1},"室友":{"cat":"学缘","sign":1,"directed":0,"default":2},"师生":{"cat":"学缘","sign":1,"directed":1,"default":1},"家人":{"cat":"亲缘","sign":1,"directed":0,"default":3},"亲戚":{"cat":"亲缘","sign":1,"directed":0,"default":2}},"categories":["情感","利益","职场","社交","学缘","亲缘"],"category_glyph":{"情感":"♥","利益":"¥","职场":"▪","社交":"●","学缘":"✎","亲缘":"⌂"},"circle_kinds":{"公司":["职场","利益","社交"],"班级":["学缘","情感","社交"],"家族":["亲缘","情感","社交"],"朋友":["社交","情感","利益"],"自定义":["情感","利益","职场","社交","学缘","亲缘"]}}');
  T.S.circle = { id: 1, name: "公司圈", kind: "公司" };
  T.S.people = [
    { id: 1, name: "陈国栋", dept: "技术部", title: "CTO", tags: "", updated_at: 100 },
    { id: 2, name: "李明远", dept: "技术部", title: "总监", tags: "", updated_at: 300 },
    { id: 3, name: "周文彬", dept: "市场部", title: "VP", tags: "", updated_at: 200 },
  ];
  const form = (over) => {
    Object.assign(T.F, { mode: "create", a: null, b: null, kind: "", cat: "",
      strength: 0, dir: "ab", notes: "", relId: null, oldKind: "",
      existing: [], open: null, q: "" }, over);
    T.renderRelForm();
    return cap["#sheetBody"] || "";
  };
  const chipOn = (h, attr, val) =>
    new RegExp(`class="btn mini primary" ${attr}="${val}"`).test(h);

  // 场景一:从人物卡点「＋ 加一条」,A 已填好只需选 B
  let h = form({ a: 1, open: "b" });
  check("默认展开的类别是「职场」(公司圈 → circle_kinds 的首项)",
        chipOn(h, "data-cat", "职场"),
        "circle_kinds 没被用上的话这里会是「情感」");
  const kindChips = [...h.matchAll(/data-kind="([^"]+)"/g)].map(m => m[1]);
  check(`类型 chip 只出当前类别那几个(${kindChips.length} 个,不是 26 个)`,
        kindChips.length === 5 &&
        kindChips.every(k => T.S.state.kinds[k].cat === "职场"),
        kindChips.join(" "));
  check("六个类别 chip 一个不少", (h.match(/data-cat="/g) || []).length === 6);
  check("没选类型时主按钮是禁用的(点了会得到 400)",
        /id="relSave" disabled/.test(h));
  check("没选类型时不出方向行", !/data-dir=/.test(h));
  check("表单里没有 undefined / NaN / [object Object]",
        !/undefined|NaN|\[object Object\]/.test(h),
        (h.match(/.{0,40}(undefined|NaN|\[object Object\]).{0,40}/) || [])[0]);

  /* 生成出来的标签里不能有两个 class —— 浏览器只认第一个。
     chip() 是拼出来的 class,源码正则看不见拼完的样子。 */
  const dupCls = [...h.matchAll(/<[a-z]+ [^>]*class="[^"]*"[^>]*class="/g)];
  check(`渲染结果里没有重复的 class 属性(${dupCls.length} 处)`, dupCls.length === 0);
  for (const tag of ["div", "button", "span", "label", "textarea"]) {
    const o = (h.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
    const c = (h.match(new RegExp(`</${tag}>`, "g")) || []).length;
    check(`<${tag}> 开合配平(${o} 开 / ${c} 合)`, o === c);
  }

  // 选人面板:排除已选的另一个人,空查询按 updated_at 倒序
  const plist = cap['#sheetBody [data-plist="b"]'] || "";
  const order = [...plist.matchAll(/data-pid="(\d+)"/g)].map(m => +m[1]);
  check("选人列表排除了已经选中的那一位,并按 updated_at 倒序",
        order.join(",") === "2,3", "实际:" + order.join(","));
  check("空查询时不出「＋ 新建」那一行", !/data-new/.test(plist));

  // 场景二:选中一个有向类型 —— 方向 chip 必须用真名
  h = form({ a: 1, b: 2, kind: "师徒", cat: "职场", strength: 2 });
  check("有向类型出方向行,两个 chip 都用真名",
        /data-dir="ab"/.test(h) && /data-dir="ba"/.test(h) &&
        h.includes("陈国栋 → 李明远") && h.includes("李明远 → 陈国栋"),
        "「A → B」这种写法用户看不懂谁提携谁");
  check("选中的类型 chip 是高亮的", chipOn(h, "data-kind", "师徒"));

  // 场景三:已有同 kind 关系 → 主按钮必须说清这是"更新",不是"再加一条"
  h = form({ a: 1, b: 2, kind: "同事", cat: "职场", strength: 1,
    existing: [{ id: 7, kind: "同事", strength: 1, a_id: 1, b_id: 2, notes: "" }] });
  check("已有同 kind 关系时,主按钮文案变成「更新现有的…(当前 +1)」",
        h.includes("更新现有的「同事」") && h.includes("+1 略有交情"),
        "让 upsert 语义在点下去之前就可见,不然用户以为自己在新增");

  // 场景四:「改」锁死类型 / 「换类型」显式警告
  h = form({ mode: "edit", a: 1, b: 2, kind: "同事", relId: 7, strength: 1 });
  check("「改」这条路径上一个类型 chip 都不出(锁死 = 永远 UPDATE)",
        !/data-kind=/.test(h) && h.includes("类型已锁定"));
  /* 方向也得锁:upsert 的键是 (circle,a,b,kind),a/b 一换位就是另一条记录,
     在"只改强度"里把方向调过来会凭空多出一条反向关系 —— 和换 kind 一个道理。 */
  h = form({ mode: "edit", a: 1, b: 2, kind: "师徒", relId: 7, strength: 2 });
  check("「改」这条路径上方向也是只读的(否则会多出一条反向关系)",
        !/data-dir=/.test(h) && h.includes("陈国栋 → 李明远"));
  h = form({ mode: "swap", a: 1, b: 2, oldKind: "同事", relId: 7, strength: 1 });
  check("「换类型」挂了 warnbox 并点名旧类型",
        /warnbox/.test(h) && h.includes("删掉「同事」"));
  check("「换类型」还能选类型(它就是要换成别的)", /data-kind=/.test(h));

  // 强度文案:滑块能滑到 -3..3 的任何一档,每一档都得有话
  const holes = [];
  for (const v of [-3, -2, -1, 0, 1, 2, 3]) {
    const m = form({ a: 1, b: 2, kind: "朋友", cat: "社交", strength: v })
      .match(/id="strVal">([^<]*)</);
    const word = m ? (m[1].split(" ")[1] || "") : "";
    if (!m || !m[1].startsWith(v > 0 ? "+" + v : String(v)) ||
        !word || word === "undefined") holes.push(`${v}→${m ? m[1] : "没渲染"}`);
  }
  check(`强度 -3..3 每一档都渲染出文案(缺 ${holes.length} 档)`,
        holes.length === 0, holes.join(" "));

  // 记一笔
  T.renderEventForm();
  const ev = cap["#sheetBody"] || "";
  check("「记一笔」表单有正文框、选人面板和保存键",
        /id="evtText"/.test(ev) && /data-plist="e"/.test(ev) &&
        /id="evtSave"/.test(ev) && !/undefined/.test(ev));

  // ==========================================================
  console.log("\n局势页:说的话必须是真的");
  // ==========================================================

  /* 一条矛盾要能被复述出来。服务端的 hostility 是一堆负强度加起来的裸数,
     印在屏幕上等于没印;这个函数负责把它翻译成三件能查证的事:
     几组人正面对上、最深一处多深、占全圈敌意多少。 */
  {
    const one = T.formatTension({ a_label: "龘一系", b_label: "龖一派",
      a_size: 8, b_size: 6, share: 43, fronts: 6, worst: 3, pairs: [] });
    check("formatTension 印出占比 43%", one.includes("43%"), one);
    check("formatTension 印出「6 组」人正面对上", one.includes("6 组"), one);
    check("formatTension 把 worst=3 翻成 STRENGTH_LABEL[-3]「势不两立」",
          one.includes("势不两立"), "裸数字 3 用户读不出这是「最深」还是「有三处」");
    check("formatTension 一个字都不提 hostility 那个裸分数",
          !/hostility/.test(one));
  }

  /* 诚实规则:top1 与 top2 差 ≥10 才配叫「主要矛盾」。
     差不够就必须说「势均力敌」—— 这一页的全部价值就在于它说的是真的。 */
  {
    const clear = T.tensionHeadline([
      { a_label: "龘一系", b_label: "龖一派", share: 55.0 },
      { a_label: "龖一派", b_label: "靐一派", share: 30.0 },
    ]);
    check("share 差 25 → 叫「主要矛盾」",
          clear.includes("主要矛盾") && !clear.includes("势均力敌"), clear);
    check("有明显头名时会把差距本身印出来(25.0 个百分点)",
          clear.includes("25.0"), clear);

    const tie = T.tensionHeadline([
      { a_label: "龘一系", b_label: "龖一派", share: 43.0 },
      { a_label: "龖一派", b_label: "靐一派", share: 39.0 },
    ]);
    check("share 差 4 → 说「势均力敌」,绝不说「主要矛盾」",
          tie.includes("势均力敌") && !tie.includes("主要矛盾"), tie);
    check("势均力敌时点明是几组(2 组)", tie.includes("有 2 组"), tie);

    // 边界:差恰好 10 算「拉开了」(leadCount 用的是严格小于)
    const edge = T.tensionHeadline([
      { a_label: "龘一系", b_label: "龖一派", share: 40.0 },
      { a_label: "龖一派", b_label: "靐一派", share: 30.0 },
    ]);
    check("差恰好 10 分算拉开了(阈值是严格小于)",
          edge.includes("主要矛盾"), edge);
    check("只有一组矛盾时不去减第二名(不会出现 NaN)",
          !/NaN|undefined/.test(
            T.tensionHeadline([{ a_label: "龘一系", b_label: "龖一派", share: 100 }])));
  }

  /* 同一条规则套到人物卡的「可以拉拢谁」上 —— 那里以前把大面积同分的第 1 名
     当「第一人选」呈现,还甩一个无量纲的 77.44。 */
  {
    const holes = [];
    for (let s = 0; s <= 100; s++) {
      const w = T.allyTier(s);
      if (!w || w === "undefined") holes.push(s);
    }
    check(`allyTier 覆盖 0~100 每一分(缺 ${holes.length} 档)`, holes.length === 0,
          "缺:" + holes.slice(0, 5).join(", "));
    check("allyTier 两端:100 分是「首选」,0 分是「基本指望不上」",
          T.allyTier(100) === "首选" && T.allyTier(0) === "基本指望不上",
          `${T.allyTier(100)} / ${T.allyTier(0)}`);
    // 表按阈值降序短路;顺序一乱会静默返回错档,而分档词看起来仍然"像对的"
    const th = T.ALLY_TIERS.map(t => t[0]);
    check("ALLY_TIERS 按阈值降序(allyTier 靠这个顺序短路)",
          th.every((v, i) => i === 0 || th[i - 1] > v), th.join(">"));
    let last = 0;
    const wordIdx = s => T.ALLY_TIERS.findIndex(t => t[1] === T.allyTier(s));
    const notMono = [];
    for (let s = 100; s >= 0; s--) {
      const i = wordIdx(s);
      if (i < last) notMono.push(s);
      last = i;
    }
    check("分数越低档位只会越差,不会跳回去", notMono.length === 0,
          "在 " + notMono.slice(0, 3).join(",") + " 分处翻了");

    const cands = [
      { name: "淼甲", score: 77.4, conflict: 3, conflict_kinds: ["敌对"],
        approach: "可以托 焱乙 引荐" },
      { name: "犇丙", score: 27.2, conflict: 2, conflict_kinds: ["竞争"],
        approach: "目前没有可用的接触路径" },
    ];
    const clear = T.allyRows(cands);
    check("拉开差距时才排 1 / 2 的名次", />1</.test(clear) && />2</.test(clear));
    check("分数印成分档词 +小字分数,不是一个裸的 77.4",
          clear.includes("首选") && /<em>77<\/em>/.test(clear) &&
          !clear.includes("77.4"), clear.slice(0, 200));

    const tied = T.allyRows([
      { name: "淼甲", score: 41, conflict: 3, conflict_kinds: ["敌对"], approach: "a" },
      { name: "犇丙", score: 40, conflict: 3, conflict_kinds: ["敌对"], approach: "b" },
      { name: "垚丁", score: 39, conflict: 2, conflict_kinds: ["竞争"], approach: "c" },
    ]);
    check("同分扎堆时明说「没有明显的第一人选」",
          tied.includes("没有明显的第一人选") && tied.includes("前 3 个人"), tied.slice(0, 200));
    check("同分扎堆时干脆不排名次(名次是 sort 给的,不是数据给的)",
          !/>1</.test(tied) && !/>2</.test(tied), tied.slice(0, 300));
    check("「可以托 X 引荐」这一行也打码(approach 里带着真名)",
          /<div class="meta blurable">[^<]*托 焱乙/.test(clear),
          "这是最容易漏的一处:名字藏在一句话里");
    check("没有候选人时给的是空态文案,不是空白",
          T.allyRows([]).includes("没找到跟他有矛盾的人"));
  }

  /* 整页跑一遍。fixture 里每个人名 / 派系名都用生僻字,互不为子串 ——
     于是可以做一件比数 blurable 个数强得多的事:**把所有 blurable 元素整个
     剜掉,再看剩下的 HTML 里还有没有名字**。漏一处就当场现形。 */
  {
    const SIT = {
      me: { id: 1, name: "淼甲", dept: "龟部",
            faction: { id: 2, label: "龘一系", size: 8, core: "焱乙", is_core: false },
            front: { faction_id: 1, label: "龖一派", size: 6, share: 53.8,
                     fronts: 3, worst: 3,
                     pairs: [{ a_id: 2, b_id: 3, a_name: "焱乙", b_name: "犇丙", w: -3 }] },
            rivals: [{ id: 3, name: "犇丙", dept: "鬻部", w: -2 }],
            rank: 5, total: 19, betweenness_pct: 11.5 },
      me_missing: null,
      tensions: [
        { a: 2, b: 1, a_label: "龘一系", b_label: "龖一派", a_size: 8, b_size: 6,
          hostility: 7, fronts: 3, worst: 3, share: 53.8,
          pairs: [{ a_id: 2, b_id: 3, a_name: "焱乙", b_name: "犇丙", w: -3 }] },
        { a: 1, b: 0, a_label: "龖一派", b_label: "靐一派", a_size: 6, b_size: 5,
          hostility: 4, fronts: 2, worst: 2, share: 30.8,
          pairs: [{ a_id: 3, b_id: 4, a_name: "犇丙", b_name: "垚丁", w: -2 }] },
        { a: 2, b: 0, a_label: "龘一系", b_label: "靐一派", a_size: 8, b_size: 5,
          hostility: 2, fronts: 1, worst: 2, share: 15.4,
          pairs: [{ a_id: 2, b_id: 4, a_name: "焱乙", b_name: "垚丁", w: -2 }] },
        // 第 4 组是为了真的撞上 slice(0,3) —— 三条数据永远测不出上限
        { a: 3, b: 0, a_label: "麤一派", b_label: "靐一派", a_size: 2, b_size: 5,
          hostility: 1, fronts: 1, worst: 1, share: 5.0,
          pairs: [{ a_id: 6, b_id: 4, a_name: "麤己", b_name: "垚丁", w: -1 }] },
      ],
      key_people: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(i => ({
        id: i, name: ["淼甲", "焱乙", "犇丙", "垚丁", "鑫戊", "麤己",
                      "龗庚", "厵辛", "灥壬", "馫癸"][i - 1],
        dept: i % 2 ? "龟部" : "鬻部",
        betweenness: 100 - i * 7, betweenness_pct: 100 - i * 7,
        friends: 4, enemies: i % 3 })),
      triangles: [1, 2, 3, 4, 5, 6].map(i => ({
        members: [{ id: 1, name: "淼甲" }, { id: 2, name: "焱乙" },
                  { id: 3, name: "犇丙" }],
        edges: [], pattern: "两个朋友互相敌视", leverage: 20 - i,
        hint: "最省力的撬点:焱乙 与 犇丙 的矛盾(强度 -3),这条边最弱" })),
      factions: [
        { id: 2, size: 3, label: "龘一系",
          members: [{ id: 1, name: "淼甲", dept: "龟部" },
                    { id: 2, name: "焱乙", dept: "龟部" },
                    { id: 5, name: "鑫戊", dept: "龟部" }],
          core: { id: 2, name: "焱乙" },
          straddlers: [{ id: 5, name: "鑫戊", straddle: 0.43 }] },
        { id: 1, size: 2, label: "龖一派",
          members: [{ id: 3, name: "犇丙", dept: "鬻部" },
                    { id: 4, name: "垚丁", dept: "鬻部" }],
          core: { id: 3, name: "犇丙" }, straddlers: [] },
      ],
    };
    // 每个都是生僻字且互不为子串 —— 剜掉 blurable 之后能一个不漏地查
    const NAMES = ["淼甲", "焱乙", "犇丙", "垚丁", "鑫戊", "麤己", "龗庚", "厵辛",
                   "灥壬", "馫癸", "龘一系", "龖一派", "靐一派", "麤一派",
                   "龟部", "鬻部"];

    const page = T.situationHtml(SIT);

    // 顺序 = 我 → 矛盾 → 人 → 下手处 → 名册。这是这一页的全部设计,
    // 谁把某一块挪到前面去,用户第一眼看到的就不再是自己的处境了。
    const order = ["我的处境", "主要矛盾", "绕不开的人", "最容易撬动的地方", "派系名册"];
    const at = order.map(s => page.indexOf(s));
    check("五块齐全", at.every(i => i >= 0),
          order.filter((_, i) => at[i] < 0).join(", ") + " 不见了");
    check("顺序是「我 → 矛盾 → 人 → 下手处 → 名册」",
          at.every((v, i) => i === 0 || at[i - 1] < v), at.join(","));

    /* blurable 守门:把带 blurable 的元素连内容一起剜掉,剩下的不该有任何人名。
       这些元素都是叶子(里面不会再嵌同名标签),所以非贪婪匹配是准的。 */
    let rest = page, prev = null;
    while (rest !== prev) {
      prev = rest;
      rest = rest.replace(
        /<(\w+)[^>]*\bclass="[^"]*\bblurable\b[^"]*"[^>]*>[\s\S]*?<\/\1>/, "");
    }
    const naked = NAMES.filter(n => rest.includes(n));
    check(`每个人名 / 派系名都在 blurable 里(核对 ${NAMES.length} 个)`,
          naked.length === 0,
          "没打码就印出来了:" + naked.join("、") +
          " —— 这一页写着「谁跟我作对」,是最不能被人瞥见的一页");
    const marks = (page.match(/blurable/g) || []).length;
    check(`blurable 出现 ${marks} 次,≥ 人名渲染点数`, marks >= 20, String(marks));

    // 上限:名单一长就翻不到底下的三角和名册
    check("绕不开的人最多 8 个",
          (page.match(/class="num dimtext rank"/g) || []).length === 8);
    check("不稳定三角最多 5 组",
          (page.match(/两个朋友互相敌视/g) || []).length === 5);
    check("主要矛盾最多 3 组", (page.match(/组人正面对上/g) || []).length === 3 + 1,
          "还要算上「我的处境」里那一处");

    check("整页没有 undefined / NaN / [object Object]",
          !/undefined|NaN|\[object Object\]/.test(page),
          (page.match(/.{0,50}(undefined|NaN|\[object Object\]).{0,50}/) || [])[0]);
    const dupCls = [...page.matchAll(/<[a-z]+ [^>]*class="[^"]*"[^>]*class="/g)];
    check(`整页没有重复的 class 属性(${dupCls.length} 处)`, dupCls.length === 0,
          "浏览器只认第一个 class,后面那个等于没写");
    const dupSty = [...page.matchAll(/<[a-z]+ [^>]*style="[^"]*"[^>]*style="/g)];
    check(`整页没有重复的 style 属性(${dupSty.length} 处)`, dupSty.length === 0);
    for (const tag of ["div", "b", "span", "details", "summary", "button"]) {
      const o = (page.match(new RegExp(`<${tag}[ >]`, "g")) || []).length;
      const c = (page.match(new RegExp(`</${tag}>`, "g")) || []).length;
      check(`<${tag}> 开合配平(${o} 开 / ${c} 合)`, o === c);
    }

    // 没设「我是谁」→ 整块换成跳设置页的 CTA,不静默降级成一片空白
    const noMe = T.situationHtml({ ...SIT, me: null, me_missing: "unset" });
    check("没设「我是谁」时给的是跳设置页的 CTA,不是空白",
          noMe.includes("还没告诉这个应用") &&
          noMe.includes(`onclick="switchView('settings')"`), noMe.slice(0, 300));
    check("「我」不在当前圈子里时说的是另一句话(两种情况不能糊成一句)",
          T.situationHtml({ ...SIT, me: null, me_missing: "outside" })
            .includes("不在"), "");
    check("没有「我」时后面四块照常出",
          ["主要矛盾", "绕不开的人", "最容易撬动的地方"].every(s => noMe.includes(s)));

    // 空圈子:五块全空也不能抛异常、不能只剩几个标题
    const empty = T.situationHtml({ me: null, me_missing: "unset", tensions: [],
                                    key_people: [], triangles: [], factions: [] });
    check("空圈子不抛异常,且每一块都有空态文案",
          empty.includes("还没有记录到跨派系的敌意") &&
          empty.includes("这个圈子里还没有人") &&
          empty.includes("目前没有不稳定的三角"), empty.slice(0, 200));
    check("空圈子不出空的「派系名册」折叠块", !empty.includes("派系名册"));

    // 缺字段的老缓存 / 半截响应也不能白屏
    check("整个 payload 是空对象时也能渲染出东西",
          T.situationHtml({}).includes("我的处境"));
    check("me 有但派系为空(正向关系太少)时说人话",
          T.situationHtml({ ...SIT, me: { ...SIT.me, faction: null, front: null,
            rivals: [] } }).includes("还没被归进任何一派"));
    check("没人跟我作对时明说,不留一块空白",
          T.situationHtml({ ...SIT, me: { ...SIT.me, rivals: [] } })
            .includes("目前没有人跟你直接结怨"));
  }
}

console.log("\nLOD:名字的详略是一个 class,不是一段循环");
/* 这一整段抓的都是"肉眼看不出来"的那类错:
   JS 加了 class 而 CSS 里没有对应规则 —— 什么都不会发生,页面也不报错;
   阈值写死成 scale —— 19 人那边看着完全正常,100 人那边永远不生效;
   迟滞被删掉 —— 只有真机在阈值附近捏合才看得见名字成片闪烁。 */
{
  // ---- ① JS 翻的 class,CSS 里必须真有规则 ----
  for (const sel of ["#svg.lod-key", "#svg.lod-none"]) {
    check(`样式表里有 ${sel} 的规则`, css.includes(sel),
          "JS 会加这个 class,但 CSS 里没有它 —— 加了等于没加,而且不报错");
  }
  check(".lod-key 是靠 .node:not(.key) 逐节点匹配的(交给样式引擎,不是 JS 循环)",
        /#svg\.lod-key \.node:not\(\.key\) \.nm\{display:none\}/.test(css));
  check("#svg.lod-none 下所有名字都不画",
        /#svg\.lod-none \.node \.nm\{display:none\}/.test(css));

  /* 「聚焦时他和邻居的名字必显」= 一条 CSS 规则,零 JS。
     四个状态类少写一个,就会出现"点开某人,他自己的名字还是不见"。 */
  for (const st of ["near", "lit", "sel", "dragging"]) {
    check(`.${st} 的名字在两档 LOD 下都强制显示`,
          new RegExp(`#svg\\.lod-key \\.node\\.${st} \\.nm`).test(css) &&
          new RegExp(`#svg\\.lod-none \\.node\\.${st} \\.nm`).test(css),
          "聚焦/悬停/拖动时那个人的名字会跟着被 LOD 藏掉");
  }
  /* 强制显示那条必须**赢过**隐藏那条。两条都是 #svg 开头,靠的是多一个类,
     而且顺序也在后面 —— 任何一样反了,规则就静默失效。 */
  check("强制显示的规则排在隐藏规则之后(同特指度时后者胜)",
        css.indexOf("#svg.lod-key .node.near .nm") >
        css.indexOf("#svg.lod-key .node:not(.key) .nm"));
  check("强制显示用的是 display:inline 而不是 block(SVG 的 <text> 认前者)",
        /#svg\.lod-none \.node\.dragging \.nm\}?[^{]*\{display:inline\}/.test(css) ||
        /\.node\.dragging \.nm\{display:inline\}/.test(css));

  // ---- ② n.key 真的落到了 DOM 上(layout.py 算了它,前端以前 0 处引用)----
  const withKey = { ...PL,
    nodes: PL.nodes.map((n, i) => ({ ...n, key: i < 5 })) };
  const svgK = GraphRender.buildSVG(withKey, GraphStyles.A);
  const gs = [...svgK.matchAll(/<g class="(node[^"]*)"/g)].map(m => m[1]);
  check(`n.key 落成了节点的 key 类(${gs.filter(s => /(^| )key( |$)/.test(s)).length} / ${
          gs.length} 个)`,
        gs.filter(s => /(^| )key( |$)/.test(s)).length === 5,
        "layout.py 算好的 n.key 前端一直 0 处引用,LOD 全靠它");
  check("没打 key 的节点 class 里也不能出现 key",
        gs.filter(s => /(^| )key( |$)/.test(s)).length ===
        withKey.nodes.filter(n => n.key).length);
  /* 类名是几段拼起来的("me " + "key " + "fac-fN"),少一个空格就会粘成
     `mekey` / `keyfac-f1` —— 两个类同时失效,而且页面一声不吭。 */
  const glued = gs.filter(s => /mekey|keyfac|nodeme|nodekey/.test(s));
  check(`拼出来的类名没有粘在一起(${glued.length} 处)`, glued.length === 0,
        glued.slice(0, 2).join(" | "));
  check("「我」那一个既有 me 也有 key(is_me 的人一定是 key)",
        gs.some(s => /(^| )me( |$)/.test(s) && /(^| )key( |$)/.test(s)) ||
        !withKey.nodes.some(n => n.is_me && n.key));
  const dupK = [...svgK.matchAll(/<g [^>]*class="[^"]*"[^>]*class="/g)];
  check(`加了 key 之后节点上仍然只有一个 class 属性(${dupK.length} 处)`,
        dupK.length === 0, "浏览器只认第一个 class");

  // ---- ③ 阈值是推出来的,不是写死的 scale ----
  const mk = (n, W, H, nameLen) => ({ width: W, height: H,
    nodes: Array.from({ length: n }, (_, i) =>
      ({ id: i, name: "名".repeat(nameLen), x: 0, y: 0, r: 17 })) });
  const lv = (p, s, ns) => GraphRender.lodLevel(
    GraphRender.lodRatio(p, s, ns || 13), "all");

  /* 真实数字(layout.canvas_of 的输出 + computeFit 在 390×844 上的结果):
       19 人竖屏画布  546×1092,复位 scale=0.636
      100 人竖屏画布 1252×2504,复位 scale=0.259
     画布随 √人数放大,所以**复位后的 scale 跟人数强相关** ——
     一个写死的 scale 阈值必然在其中一边判反。 */
  const p19 = mk(19, 546, 1092, 3), p100 = mk(100, 1252, 2504, 3);
  const p100long = mk(100, 1252, 2504, 5);      // 「欧阳明日香」这种五字名
  check("19 人复位后名字全开", lv(p19, 0.636) === "all",
        "ratio=" + GraphRender.lodRatio(p19, 0.636, 13).toFixed(2));
  check("100 人 + 五字名,复位后只留 key(名字宽度也是阈值的一维)",
        lv(p100long, 0.259) === "key",
        "ratio=" + GraphRender.lodRatio(p100long, 0.259, 13).toFixed(2));
  check("同一份布局,五字名比三字名先收(阈值吃的是宽度不是人数)",
        lv(p100long, 0.259) !== lv(p100, 0.259));
  /* 硬阈值错在哪:100 人放大到 0.55 时,间距 68px、名字才 22.6px,
     明明绰绰有余,而 `scale > 0.6` 那条规则还藏着不给看。 */
  check("写死 scale>0.6 会判反:100 人放到 0.55 时名字早就放得下了",
        GraphRender.lodRatio(p100, 0.55, 13) > 1.5 && 0.55 < 0.6,
        "ratio=" + GraphRender.lodRatio(p100, 0.55, 13).toFixed(2));
  /* 另一维:画布形状。竖屏 560×1120 和宽屏 1500×900 的 √(面积/人数)
     差 1.47 倍,同样人数、同一个 scale,判断就能不同。 */
  check("同样 60 人、同一个 scale,竖屏和宽屏的判断可以不一样",
        lv(mk(60, 970, 1940, 5), 0.25) !== lv(mk(60, 2598, 1559, 5), 0.25),
        `竖屏 ${GraphRender.lodRatio(mk(60, 970, 1940, 5), 0.25, 13).toFixed(2)} / ` +
        `宽屏 ${GraphRender.lodRatio(mk(60, 2598, 1559, 5), 0.25, 13).toFixed(2)}`);
  check("100 人放大到看得清时,名字会全开回来",
        lv(p100long, 0.9) === "all");
  check("捏到很小时连 key 的名字也不画",
        lv(p100, 0.09) === "none",
        "ratio=" + GraphRender.lodRatio(p100, 0.09, 13).toFixed(2));

  /* 把"在哪个缩放上开始收名字"直接打出来。这不是断言,是给人看的 ——
     LOD 到底激不激进,只有真机上才判得了;打出来之后,想调就只是改
     LOD_NN_FACTOR 一个常量,而且改完这一行会立刻反映出来。 */
  const onset = (p, ns) => {
    for (let s = 2; s > 0.02; s -= 0.005)
      if (GraphRender.lodLevel(GraphRender.lodRatio(p, s, ns), "all") !== "all")
        return s.toFixed(3);
    return "<0.02";
  };
  console.log(`     开始收名字的缩放:19 人三字名 ${onset(p19, 13)}(复位 0.636)` +
              ` / 100 人三字名 ${onset(p100, 13)}(复位 0.259)` +
              ` / 100 人五字名 ${onset(p100long, 13)}`);
  check("空图不会除以零",
        GraphRender.lodRatio({ width: 100, height: 100, nodes: [] }, 1, 13)
          === Infinity && lv({ width: 100, height: 100, nodes: [] }, 1) === "all");

  /* ④ 迟滞。没有它的话,在阈值附近手指抖一下,几十个名字会成片地
     开、关、开 —— 比一直不显示还难受,而且只有真机捏合才看得见。 */
  const levels = ["none", "key", "all"];
  let flips = 0, cur = "all";
  // 在 all/key 边界(ratio=1)上下 ±3% 来回摆 40 次
  const base = 1.0 / GraphRender.lodRatio(p100, 1, 13);   // 令 ratio 恰好为 1 的 scale
  for (let i = 0; i < 40; i++) {
    const nxt = GraphRender.lodLevel(
      GraphRender.lodRatio(p100, base * (i % 2 ? 1.03 : 0.97), 13), cur);
    if (nxt !== cur) flips++;
    cur = nxt;
  }
  check(`阈值附近 ±3% 抖 40 次,LOD 最多翻 1 次(实际 ${flips} 次)`, flips <= 1,
        "迟滞没了 —— 真机上会看到名字成片闪烁");
  check("迟滞是 ±8%,写在一个常量里", GraphRender.LOD_HYST === 0.08);
  // 但真的越过死区还是要跟着变,不能因为迟滞就卡死
  check("越过 ±8% 的死区之后照常切换",
        GraphRender.lodLevel(GraphRender.lodRatio(p100, base * 1.2, 13), "key")
          === "all" &&
        GraphRender.lodLevel(GraphRender.lodRatio(p100, base * 0.6, 13), "all")
          === "key" &&
        GraphRender.lodLevel(GraphRender.lodRatio(p100, base * 0.3, 13), "key")
          === "none");
  // 迟滞只能"留在原处",绝不能让缩小反而显示得更多
  const mono = [];
  for (let s = 0.05; s < 2; s += 0.01) {
    for (const prev of levels) {
      const a = levels.indexOf(GraphRender.lodLevel(
        GraphRender.lodRatio(p100, s, 13), prev));
      const b = levels.indexOf(GraphRender.lodLevel(
        GraphRender.lodRatio(p100, s + 0.01, 13), prev));
      if (b < a) mono.push(s.toFixed(2));
    }
  }
  check(`放大只会让名字显示得更多,不会更少(扫了 ${
          Math.round(1.95 / 0.01) * 3} 个组合)`, mono.length === 0,
        "在 scale=" + mono.slice(0, 3).join(",") + " 处翻了");

  /* ⑤ NN_FACTOR 是布局的一条经验性质,不是随手挑的数。
     拿上面那份**真实坐标**核一遍:平均最近邻距离 / √(面积/人数)。
     布局哪天散开(接近 1)或者塌成一团(远小于 0.5),LOD 阈值的前提就不成立了,
     这条会先响 —— 而屏幕上的表现只是"名字忽多忽少",没人看得出是这里的事。 */
  for (const [bucket, fx] of Object.entries(FIXTURE)) {
    const ns = fx.nodes.map(([nm, x, y, r]) => ({ x, y }));
    const nn = ns.map(a => Math.min(...ns.filter(b => b !== a)
      .map(b => Math.hypot(a.x - b.x, a.y - b.y))));
    const f = (nn.reduce((s, v) => s + v, 0) / nn.length) /
              Math.sqrt(fx.width * fx.height / ns.length);
    check(`${bucket}:真实布局的最近邻系数 ${f.toFixed(2)} 落在 0.5~0.9 之间`,
          f >= 0.5 && f <= 0.9,
          "布局的疏密变了,LOD 阈值的前提不再成立");
  }
  check(`LOD_NN_FACTOR(${GraphRender.LOD_NN_FACTOR})落在同一个区间里`,
        GraphRender.LOD_NN_FACTOR >= 0.5 && GraphRender.LOD_NN_FACTOR <= 0.9);

  /* ⑥ --gscale 的反向补偿曲线一个字都不许动 —— computeFit 整套算法
     建立在"名字是恒定屏幕像素、球是画布单位"这个二分上,
     上一版就是栽在混淆这两个坐标系。正解是减少名字数量,不是改字号。 */
  check("名字的字号仍然是 nameSize / var(--gscale)(没有偷偷改补偿曲线)",
        /font-size:calc\(\$\{style\.nameSize\}px \/ var\(--gscale,1\)\)/.test(gjs) &&
        /transform:translateY\(calc\(\$\{style\.nameSize\}px \/ var\(--gscale,1\)\)\)/.test(gjs),
        "改了它 fittest 的贴合用例和 computeFit 会一起失效");
}

console.log("\n性能:100 人时 SVG 元素数");
{
  /* 三处降级合起来该省多少,这里直接数出来,不靠我手算的估计。
     数的是开标签的个数(自闭合的 <circle .../> 也算一个元素)。 */
  const count = s => (s.match(/<[a-z]/g) || []).length;
  // 画布尺寸是 layout.canvas_of 的真实输出;100 人的真实边数实测 375 条
  const mkBig = (W, H) => ({
    width: W, height: H, density: 0.62,
    nodes: Array.from({ length: 100 }, (_, i) => ({
      id: i + 1, name: "陈国栋", x: (i % 10) * 120 + 20,
      y: Math.floor(i / 10) * 240 + 20,
      r: 17, initial: "陈", frank: i % 4, is_me: i === 0, key: i % 3 === 0 })),
    edges: Array.from({ length: 375 }, (_, i) => ({
      a: (i % 100) + 1, b: ((i * 7) % 100) + 1,
      x1: 20, y1: 20, x2: 900, y2: 2000, cx: 400, cy: 900, mx: 450, my: 950,
      w: (i % 5) - 2, width: 1.5, label: "同事", glyph: "▪", count: 1 })),
  });

  /* "改之前"用同一份代码算:只把封顶和降级两个常量顶到无穷大,其余一模一样。
     这样对比出来的是真实差值,而不是两份各写一遍的估算。 */
  const raw = fs.readFileSync(path.join(__dirname, "web", "graph.js"), "utf8")
    .replace(/const STAR_CAP = \d+;/, "const STAR_CAP = Infinity;")
    .replace(/const STREAK_MAX_EDGES = \d+;/, "const STREAK_MAX_EDGES = Infinity;");
  const tmp2 = path.join(os.tmpdir(), "_graph_before_lod.js");
  fs.writeFileSync(tmp2, raw + "\n;module.exports={GraphRender,GraphStyles};");
  const RB = require(tmp2).GraphRender;

  for (const [label, W, H] of [["竖屏", 1252, 2504], ["宽屏", 3354, 2012]]) {
    const big = mkBig(W, H);
    const now = count(GraphRender.buildSVG(big, GraphStyles.A));
    const before = count(RB.buildSVG(big, GraphStyles.A));
    console.log(`     100 人 / 375 条边 / ${label} ${W}×${H}:` +
                `${before} → ${now} 个元素(省 ${before - now},` +
                `${(100 - now / before * 100).toFixed(0)}%)`);
    check(`${label}:SVG 元素数降到 2600 以内(实测 ${now})`, now <= 2600,
          "三处降级里有一处没生效");
    check(`${label}:降幅超过 40%(${before} → ${now})`, now < before * 0.6);
  }

  const big = mkBig(3354, 2012);           // 6.75M px²,星点封顶最吃紧的一档
  check(`星点封顶 ${GraphRender.STAR_CAP}(不封的话这张画布上 A 档要画 ${
          Math.round(GraphStyles.A.stars * 3354 * 2012 / 1300000)} 个圆)`,
        (GraphRender.buildSVG(big, GraphStyles.A)
          .match(/<circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+" opacity/g)
          || []).length === GraphRender.STAR_CAP);
  check(`流光在 ${big.edges.length} 条边时已经关掉(阈值 ${GraphRender.STREAK_MAX_EDGES})`,
        !GraphRender.buildSVG(big, GraphStyles.A).includes("<linearGradient"));
  // 边少的时候一样都不能省 —— 降级只在真的吃不消时才该发生
  const small = { ...mkBig(546, 1092), edges: mkBig(546, 1092).edges.slice(0, 40) };
  check("19~60 人这一档什么都不降级(星点没到顶、流光照常开)",
        GraphRender.buildSVG(small, GraphStyles.A).includes("<linearGradient") &&
        (GraphRender.buildSVG(small, GraphStyles.A)
          .match(/<circle cx="[\d.]+" cy="[\d.]+" r="[\d.]+" opacity/g) || []).length
          < GraphRender.STAR_CAP);
}

console.log("\n性能:settle 与人物页");
{
  /* settle() 现在还兼管 LOD,所以它在**纯平移**时也会被叫到 ——
     没有这个短路的话,拖一下画布就会重写 --gscale,而它被所有节点名和
     边标签的 calc() 引用:100 人时约 500 个文本元素为一次毫无变化的
     变量写入集体重排。这只有在真机上"拖动发烫"才感觉得到。 */
  const st = gjs.slice(gjs.indexOf("function settle()"),
                       gjs.indexOf("\n  }", gjs.indexOf("function settle()")));
  check("settle 里有 lastScale 的短路(纯平移不再重写 --gscale)",
        /if \(s === lastScale\) return;/.test(st) && /lastScale = s;/.test(st),
        "拖动画布会让约 500 个文本元素无谓重排");
  check("短路在写 --gscale 之前(写完再判等于没判)",
        st.indexOf("=== lastScale") < st.indexOf("--gscale"));
  check("换了 payload 会重置 lastScale(人数变了,同一个 scale 的疏密也变了)",
        /lastScale = -1;/.test(gjs));
  check("LOD 的决策也在 settle 里(90ms 防抖),不是每帧",
        /applyLod\(s\);/.test(st) &&
        !/applyLod/.test(gjs.slice(gjs.indexOf("function queueMove"),
                                   gjs.indexOf("function beginDrag"))),
        "每帧改 DOM 是这个项目的红线,拖动那一处是唯一有意开的例外");
  check("applyLod 只翻 #svg 上的 class,不遍历节点",
        /svg\.classList\.toggle\("lod-key"/.test(gjs) &&
        !/querySelectorAll\("\.node"\)[\s\S]{0,80}lod/.test(gjs),
        "逐节点的匹配必须交给样式引擎");

  // ---- 人物页:建一次,之后只翻 hidden ----
  check("人物页的列表只建一次(靠数组引用 + 着色签名判断要不要重建)",
        /function buildPeopleList\(box\)/.test(ajs) &&
        /function filterPeople\(box\)/.test(ajs) &&
        /peopleBuilt\[0\] !== S\.people/.test(ajs),
        "每敲一个键全量重建 innerHTML = O(人数²),还会把滚动位置甩回顶部");
  check("过滤只翻 row.hidden,不碰 innerHTML",
        /row\.hidden = !hit;/.test(ajs) &&
        !/innerHTML/.test(ajs.slice(ajs.indexOf("function filterPeople"),
                                    ajs.indexOf("\n}", ajs.indexOf("function filterPeople")))));
  /* 这一条最容易漏,而且漏了以后"搜索完全没反应"却不报任何错:
     .row 自己写着 display:flex,UA 样式表里的 [hidden]{display:none}
     特指度只有 (0,1,0),直接被盖掉。 */
  check("[hidden] 在样式表里被显式压过组件的 display(.row 是 display:flex)",
        /\[hidden\]\{display:none !important\}/.test(css),
        "元素挂了 hidden 却照样显示 —— 搜索看起来像坏了,而且不报错");
  check("搜索键预存在 data-q 里(不再每行现拼现小写)",
        /data-q="\$\{esc\(searchKey\(p\)\)\}"/.test(ajs));
  const bpl = ajs.slice(ajs.indexOf("function buildPeopleList"),
                        ajs.indexOf("\n}", ajs.indexOf("function buildPeopleList")));
  check("人物页的点击走事件委托,行里不再拼 onclick 字符串",
        /\$\("#peopleList"\)\.onclick = e => \{/.test(ajs) &&
        /data-pid="\$\{p\.id\}"/.test(bpl) && !/onclick=/.test(bpl),
        "以前每一行拼一个 onclick,而那一整块每敲一个键就重建一遍");
  check("空态那一行也在,并且不参与过滤",
        /id="peopleNone"/.test(ajs) && /if \(!row\.dataset\.q\) continue;/.test(ajs));

  // ---- nodeColor 走 byId ----
  check("nodeColor 用 buildIndex 建好的 byId,不再线性 find",
        /byId = new Map\(payload\.nodes\.map/.test(gjs) &&
        /const n = byId \? byId\.get\(id\) : null;/.test(gjs) &&
        !/data\.nodes\.find\(x => x\.id === id\)/.test(gjs),
        "人物页一次搜索要调它上百次");
}

console.log("\n打码:不画字,而不是把字糊掉");
{
  /* filter / backdrop-filter 是本项目写在 style.css 开头的性能红线
     (iOS Safari 上极慢,光晕就是为了躲开它才用 SVG 渐变画的)。
     而 blur(5px) 对 13px 的中文只是"糊",骨架还在,凑近能猜 ——
     偏偏这个开关的用途就是"旁边有人"。这两条自动守住。 */
  const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const filters = cssCode.match(/[a-z-]*filter\s*:/g) || [];
  check(`整份样式表一处 filter / backdrop-filter 都没有(发现 ${filters.length} 处)`,
        filters.length === 0, "项目性能红线:" + filters.join(", "));

  const maskRules = [...cssCode.matchAll(/body\.masked[^{]*\{([^}]*)\}/g)];
  check(`打码规则至少有 3 条(HTML 侧色带 + SVG 侧描边,实际 ${maskRules.length} 条)`,
        maskRules.length >= 3);
  check("打码规则里一处 filter 都没有",
        !maskRules.some(m => /filter/.test(m[1])),
        "blur 对 13px 中文只是糊,凑近就能猜出来 —— 而且它是性能红线");
  check("HTML 侧靠 color:transparent + 背景色带",
        maskRules.some(m => /color:transparent/.test(m[1])) &&
        maskRules.some(m => /background:var\(--dim\)/.test(m[1])));
  check("换行时每行各自成条(box-decoration-break:clone)",
        /box-decoration-break:clone/.test(cssCode) &&
        /-webkit-box-decoration-break:clone/.test(cssCode),
        "不写它两行会连成一个大色块,反而暴露了这段话有多长");
  /* .avatar 必须排除:它的 background 是内联的球色(数据驱动),
     被色带盖掉的话圆会变方块,而且丢掉"靠颜色还能分派系"这件事。 */
  check(".avatar 被排除在背景色带之外(否则圆会变方块)",
        /body\.masked \.blurable:not\(\.avatar\)/.test(cssCode));
  check(".avatar 自己仍然 color:transparent(首字要藏,球色要留)",
        /body\.masked \.avatar\.blurable\{color:transparent/.test(cssCode));

  // SVG 侧:<text> 不吃 background,改用同色粗描边把笔画内白填死
  check("SVG 侧用 paint-order:normal + 粗描边(<text> 不吃 background)",
        /body\.masked #svg[\s\S]{0,160}paint-order:normal/.test(cssCode) &&
        /stroke-width:0\.58em/.test(cssCode),
        "只改颜色不改 paint-order 会得到一圈粗边加中间一个清楚的白字");
  check("描边宽度用 em 不用 px(这几处字号都带着 / var(--gscale) 的反向补偿)",
        !/body\.masked[^{]*\{[^}]*stroke-width:\s*[\d.]+px/.test(cssCode));
  /* 浅色主题那条 `:root[data-theme="light"] .node .nm{stroke:#fff;...}` 有四个类,
     光靠 body.masked .node .nm(三个类)会输给它 —— 于是浅色下打码整个失效,
     而深色下看着完全正常。特指度这种事只有静态检查抓得住。 */
  check("打码的 SVG 规则带上了 #svg(特指度要压过浅色主题那条 stroke:#fff)",
        /body\.masked #svg \.node \.nm\{stroke:var\(--text\)\}/.test(cssCode),
        "浅色主题下打码会被 :root[data-theme=light] .node .nm 盖掉");
  const lightNm = /:root\[data-theme="light"\] \.node \.nm\{/.test(css);
  check("浅色主题那条规则确实还在(上面那条防的就是它)", lightNm);
}

console.log("\n打码范围:这一轮补上的四处");
/* 「情敌 · 去年年会上为了同一个人吵起来」是全库最敏感的一行,
   而它一直印在人物卡的关系列表里,没有 blurable。
   这类漏网只有逐处静态核对才抓得到 —— 屏幕上它长得和别的行一模一样。 */
for (const [what, re] of [
  ["人物卡的部门职位", /<div class="sub blurable">\$\{esc\(p\.dept \|\| ""\)\}/],
  ["人物卡关系行的类型与备注(最敏感的一行)",
   /<div class="meta blurable">\$\{esc\(r\.glyph \|\| ""\)\} \$\{esc\(r\.kind\)\}/],
  ["连线卡的方向(里面是两个真名)", /<div class="meta blurable">方向:/],
  ["人物页列表的部门职位", /<div class="meta blurable">\$\{esc\(p\.dept \|\| "—"\)\}/],
  ["AI 审核列表的部门职位",
   /<div class="meta blurable">\$\{esc\(p\.dept \|\| ""\)\} \$\{esc\(p\.title \|\| ""\)\}/],
  ["「改强度」里只读的方向行", /<div class="card"><span class="blurable">\$\{esc\(a\.name\)\} → /],
]) check(`打码:${what}`, re.test(ajs), "这一处的真名会原样印在屏幕上");
/* 引荐路径本来就该是 blurable(「张三 → 李四 → 王五」整条都是真名)。
   它已经有了,钉住免得以后被谁顺手清理掉。 */
check("打码:引荐路径整条(b.intro.path 全是真名)",
      /<div class="card"><div class="blurable">\s*\$\{b\.intro\.path\.map/.test(ajs));

console.log("\n模板里的引用能不能对上(只有静态检查抓得到)");
{
  /* $("#xxx") 拿不到元素时后面一律是 `null.onclick` —— 手机上没有控制台,
     表现就是"点了没反应"。这两条把 id 和事件处理器的名字都对一遍。 */
  const used = [...ajs.matchAll(/\$\("#([A-Za-z][\w-]*)"\)/g)].map(m => m[1]);
  const defined = new Set(
    [...(ajs + html).matchAll(/id="([A-Za-z][\w-]*)"/g)].map(m => m[1]));
  const ghosts = [...new Set(used)].filter(i => !defined.has(i));
  check(`每个 $("#id") 都有对应的元素(用到 ${new Set(used).size} 个)`,
        ghosts.length === 0, "找不到:" + ghosts.join(", "));

  const called = [...(ajs + html).matchAll(/onclick="([A-Za-z_$][\w$]*)\(/g)]
    .map(m => m[1]);
  const decl = new Set(
    [...ajs.matchAll(/function ([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]));
  const known = new Set(["GraphView"]);
  const dead = [...new Set(called)].filter(f => !decl.has(f) && !known.has(f));
  check(`每个 onclick="fn(" 都能找到 fn(用到 ${new Set(called).size} 个)`,
        dead.length === 0, "没定义:" + dead.join(", "));
}

console.log("\n" + "=".repeat(52));
console.log(`  通过 ${ok} / 失败 ${fail}`);
console.log("=".repeat(52));
process.exit(fail ? 1 : 0);
