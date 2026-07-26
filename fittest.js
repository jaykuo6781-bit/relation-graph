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
const cmp = fs.readFileSync(path.join(__dirname, "web", "compare.html"), "utf8");
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
check("双击文件打开时,对比页会给出明确提示",
      cmp.includes('location.protocol === "file:"'));

console.log("\n" + "=".repeat(52));
console.log(`  通过 ${ok} / 失败 ${fail}`);
console.log("=".repeat(52));
process.exit(fail ? 1 : 0);
