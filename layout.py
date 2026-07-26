"""力导向布局 —— 整个方案的性能关键。

常规的网页关系图是在浏览器里跑物理模拟循环:每秒几十帧,反复计算
每个节点受到的斥力和引力。这正是手机发热的来源。

这里把这一步整个搬到电脑上:服务端算出每个节点最终的 (x, y),
手机拿到的是一份已经排好版的静态坐标,只负责画。手机端没有任何
物理循环,平移缩放走 CSS transform 由 GPU 合成,CPU 基本闲置。

除了坐标,服务端还把**画一条弧线所需的全部参数**都算好了(贝塞尔控制点、
标签落点、类别标记符),手机端连一次三角函数都不用做。

布局按圈子分别计算与缓存 —— 切圈子只是换一份已经算好的坐标。
"""

import json
import math
import random
from collections import defaultdict

import analysis
import db

FULL_ITERATIONS = 300      # 冷启动(没有历史坐标)
WARM_ITERATIONS = 80       # 增量(有历史坐标,只需微调)

# ---- 画布尺寸按屏幕比例自适应 ----
# 写死正方形画布的后果:宽屏上按高度贴合,左右浪费一半;竖屏上反过来。
# 这里按几个固定档位取整再算布局 —— 取整是为了让缓存仍然有效,
# 不能每拖一下窗口就重算一遍布局。
ASPECT_BUCKETS = {
    "portrait": (760.0, 1180.0),   # 手机竖屏
    "square":   (1000.0, 1000.0),  # 方形 / 平板
    "wide":     (1500.0, 900.0),   # 桌面宽屏
}
DEFAULT_BUCKET = "square"

# 画布按人数缩放的基准人数。
# 之前画布尺寸写死,理想边长 k = √(画布面积/人数) 就会随人数剧烈变化:
# 19 个人配 1500×900 算出 k≈266,而画布才 1500 宽 —— 所有节点被斥力
# 顶到四壁,中间空出一个大洞。让画布随 √人数 缩放,每个节点分到的面积
# 就恒定了,19 人和 100 人的疏密观感一致。
BASE_NODES = 20.0
MIN_CANVAS_SCALE = 0.55
MAX_CANVAS_SCALE = 2.6

# ---- 弧度 ----
# 弧度必须封顶。按弦长的固定比例给,长边会被拉成横跨全屏的巨大弓形 ——
# 画面立刻变成一团意面,这是 v2 最毁观感的一条。
# 短边保留优雅的小弧,长边几乎拉直,才是成熟图谱工具的做法。
CURVE = 0.10                # 弦长比例
CURVE_CAP_RATIO = 0.034     # 上限 = 画布对角线 × 这个比例

# 向心力强度。太小治不住"全贴四壁",太大会把图挤成一坨。
GRAVITY = 0.055


def bucket_of(aspect):
    """把屏幕宽高比归到档位。aspect = 宽 / 高。"""
    if not aspect or aspect <= 0:
        return DEFAULT_BUCKET
    if aspect < 0.85:
        return "portrait"
    if aspect > 1.35:
        return "wide"
    return "square"


def canvas_of(bucket, n_nodes=None):
    """档位决定画布形状,人数决定画布大小。

    人数不给就用基准尺寸(向后兼容旧调用)。
    """
    w, h = ASPECT_BUCKETS.get(bucket, ASPECT_BUCKETS[DEFAULT_BUCKET])
    if not n_nodes:
        return w, h
    k = math.sqrt(max(1, n_nodes) / BASE_NODES)
    k = max(MIN_CANVAS_SCALE, min(MAX_CANVAS_SCALE, k))
    return w * k, h * k


def _seed_key(circle_id, bucket):
    return f"layout_seed_{circle_id or 'all'}_{bucket}"


def _load_seed(circle_id, bucket):
    raw = db.get_meta(_seed_key(circle_id, bucket))
    if not raw:
        return {}
    try:
        return {int(k): v for k, v in json.loads(raw).items()}
    except (json.JSONDecodeError, ValueError, TypeError):
        return {}


def _save_seed(circle_id, bucket, pos):
    db.connect()
    with db.tx():
        db.set_meta(_seed_key(circle_id, bucket), json.dumps(
            {str(k): [round(v[0], 2), round(v[1], 2)] for k, v in pos.items()}))


def compute(nodes, pos_adj, neg_adj, factions, circle_id=None,
            bucket=DEFAULT_BUCKET):
    """Fruchterman-Reingold 变体。

    在标准算法基础上加了两条针对"人际关系图"的规则:
      - 负向边额外产生斥力 —— 有矛盾的人在图上应该离得远
      - 同派系的人有轻微的额外引力 —— 圈子在视觉上抱团
    """
    n = len(nodes)
    WIDTH, HEIGHT = canvas_of(bucket, n)
    if n == 0:
        return {}
    if n == 1:
        return {nodes[0]: (WIDTH / 2, HEIGHT / 2)}

    seed = _load_seed(circle_id, bucket)
    # 固定随机种子:同一份数据每次算出来的图是一样的,不会随机跳动
    rng = random.Random(20260101)

    pos = {}
    warm = 0
    for i, v in enumerate(nodes):
        if v in seed and isinstance(seed[v], (list, tuple)) and len(seed[v]) == 2:
            pos[v] = [float(seed[v][0]), float(seed[v][1])]
            warm += 1
        else:
            # 没有历史坐标的新节点:撒在圆周上,避免所有新点重叠在中心
            ang = 2 * math.pi * i / n
            r = 0.35 * min(WIDTH, HEIGHT)
            pos[v] = [WIDTH / 2 + r * math.cos(ang) + rng.uniform(-20, 20),
                      HEIGHT / 2 + r * math.sin(ang) + rng.uniform(-20, 20)]

    iterations = WARM_ITERATIONS if warm >= n * 0.8 else FULL_ITERATIONS

    area = WIDTH * HEIGHT
    k = math.sqrt(area / n)          # 理想边长
    temp = WIDTH / 10.0
    cooling = temp / (iterations + 1)

    for _ in range(iterations):
        disp = {v: [0.0, 0.0] for v in nodes}

        # --- 斥力:所有点两两相斥 ---
        for i in range(n):
            vi = nodes[i]
            xi, yi = pos[vi]
            for j in range(i + 1, n):
                vj = nodes[j]
                dx = xi - pos[vj][0]
                dy = yi - pos[vj][1]
                d2 = dx * dx + dy * dy
                if d2 < 0.01:
                    dx, dy = rng.uniform(-1, 1), rng.uniform(-1, 1)
                    d2 = dx * dx + dy * dy
                d = math.sqrt(d2)

                force = (k * k) / d
                # 有矛盾的人额外推开,强度越大推得越远
                nw = neg_adj.get(vi, {}).get(vj)
                if nw:
                    force *= (1.0 + 0.8 * abs(nw))

                fx, fy = force * dx / d, force * dy / d
                disp[vi][0] += fx; disp[vi][1] += fy
                disp[vj][0] -= fx; disp[vj][1] -= fy

        # --- 引力:正向边把人拉近,交情越铁拉得越紧 ---
        for v, nbrs in pos_adj.items():
            for u, w in nbrs.items():
                if v >= u:
                    continue
                dx = pos[v][0] - pos[u][0]
                dy = pos[v][1] - pos[u][1]
                d = math.sqrt(dx * dx + dy * dy) or 0.01
                force = (d * d) / k * (0.5 + 0.35 * w)
                fx, fy = force * dx / d, force * dy / d
                disp[v][0] -= fx; disp[v][1] -= fy
                disp[u][0] += fx; disp[u][1] += fy

        # --- 向心力 ---
        # Fruchterman-Reingold 原版只有斥力和引力,没有任何把节点拉回来的力,
        # 结果所有点一路往外飘直到撞上边界钳制 —— 表现就是"全贴在四壁上,
        # 中间空一个大洞"。加一个弱重力把整张图收拢回画布中心。
        cx0, cy0 = WIDTH / 2, HEIGHT / 2
        for v in nodes:
            disp[v][0] -= (pos[v][0] - cx0) * GRAVITY
            disp[v][1] -= (pos[v][1] - cy0) * GRAVITY

        # --- 同派系的轻微抱团 ---
        if factions:
            centers = defaultdict(lambda: [0.0, 0.0, 0])
            for v in nodes:
                c = factions.get(v)
                if c is None:
                    continue
                centers[c][0] += pos[v][0]
                centers[c][1] += pos[v][1]
                centers[c][2] += 1
            for v in nodes:
                c = factions.get(v)
                if c is None or centers[c][2] < 2:
                    continue
                cx = centers[c][0] / centers[c][2]
                cy = centers[c][1] / centers[c][2]
                disp[v][0] -= (pos[v][0] - cx) * 0.03
                disp[v][1] -= (pos[v][1] - cy) * 0.03

        # --- 位移(受温度限制)+ 边界约束 ---
        for v in nodes:
            dx, dy = disp[v]
            d = math.sqrt(dx * dx + dy * dy)
            if d > 0:
                lim = min(d, temp)
                pos[v][0] += dx / d * lim
                pos[v][1] += dy / d * lim
            pos[v][0] = min(WIDTH - 20, max(20.0, pos[v][0]))
            pos[v][1] = min(HEIGHT - 20, max(20.0, pos[v][1]))

        temp -= cooling

    return {v: (pos[v][0], pos[v][1]) for v in nodes}


def _arc(x1, y1, x2, y2, cap):
    """算出一条弧线的控制点,以及曲线中点(标签和标记符落在这里)。

    弯曲方向由端点坐标唯一决定,所以同一条边每次渲染都朝同一边弯,
    不会闪来闪去。

    cap 是弧高上限 —— 没有它的话,横跨画布的长边会被拉成巨大的弓形。
    """
    dx, dy = x2 - x1, y2 - y1
    length = math.hypot(dx, dy) or 1.0
    mx, my = (x1 + x2) / 2, (y1 + y2) / 2
    # 垂直于弦的单位向量
    px, py = -dy / length, dx / length
    off = min(CURVE * length, cap)
    cx, cy = mx + px * off, my + py * off
    # 二次贝塞尔在 t=0.5 处的点
    qx = 0.25 * x1 + 0.5 * cx + 0.25 * x2
    qy = 0.25 * y1 + 0.5 * cy + 0.25 * y2
    return cx, cy, qx, qy


def _edge_display(kinds, w):
    """决定一条边怎么显示:标签取最强的那个关系,标记符取它的类别。"""
    if not kinds:
        return {"label": "", "cat": "社交", "glyph": "", "count": 0}
    dominant = max(kinds, key=lambda k: abs(k.get("strength", 0)))
    cat = dominant.get("cat", "社交")
    return {
        "label": dominant["kind"],
        "cat": cat,
        "glyph": db.CATEGORY_GLYPH.get(cat, ""),
        "count": len(kinds),
        "all_kinds": [k["kind"] for k in kinds],
    }


def get_graph_payload(circle_id=None, aspect=None):
    """图谱视图要的全部数据 —— 坐标、弧线、粗细都已算好。

    手机端拿到后直接画,不做任何计算。
    """
    bucket = bucket_of(aspect)
    cache_key = f"graph_payload_{circle_id or 'all'}_{bucket}"
    cached = db.cache_get(cache_key)
    if cached is not None:
        return cached

    g = analysis.build_graph(circle_id)
    people = g["people"]
    nodes_ids = sorted(people.keys())
    WIDTH, HEIGHT = canvas_of(bucket, len(nodes_ids))

    fac = analysis.detect_factions(circle_id)
    faction_of = {int(k): v for k, v in fac["assignment"].items()}

    # 中介中心性决定节点大小 —— 一眼看出谁是绕不开的
    bt = analysis._brandes(nodes_ids, g["pos_adj"]) if nodes_ids else {}
    mx_bt = max(bt.values()) if bt else 0

    pos = compute(nodes_ids, g["pos_adj"], g["neg_adj"], faction_of,
                  circle_id, bucket)
    if pos:
        _save_seed(circle_id, bucket, pos)

    # 圈子大小排名 —— 前 3 大的圈子拿到分类色,其余归中性灰
    fsize = defaultdict(int)
    for pid in nodes_ids:
        fsize[faction_of.get(pid, 0)] += 1
    frank = {fid: i for i, (fid, _) in enumerate(
        sorted(fsize.items(), key=lambda kv: (-kv[1], kv[0])))}

    # 人多时球体和光晕都要收敛 —— 参考图只有 4 个球,100 个大球会糊成光晕粥
    n_all = max(1, len(nodes_ids))
    shrink = max(0.62, min(1.0, math.sqrt(24.0 / n_all)))
    node_base = 17.0 * shrink
    node_span = 16.0 * shrink

    nodes = []
    for pid in nodes_ids:
        p = people[pid]
        x, y = pos.get(pid, (WIDTH / 2, HEIGHT / 2))
        importance = (bt.get(pid, 0) / mx_bt) if mx_bt else 0.0
        name = p["name"]
        nodes.append({
            "id": pid,
            "name": name,
            "initial": name[0] if name else "?",
            "dept": p.get("dept", ""),
            "title": p.get("title", ""),
            "is_me": bool(p.get("is_me", 0)),
            "x": round(x, 1),
            "y": round(y, 1),
            "faction": faction_of.get(pid, 0),
            "frank": frank.get(faction_of.get(pid, 0), 99),
            "r": round(node_base + node_span * importance, 1),
            "friends": len(g["pos_adj"].get(pid, {})),
            "enemies": len(g["neg_adj"].get(pid, {})),
        })

    curve_cap = CURVE_CAP_RATIO * math.hypot(WIDTH, HEIGHT)
    edges = []
    for (a, b), w in g["pair_w"].items():
        if w == 0 or a not in pos or b not in pos:
            continue
        x1, y1 = pos[a]
        x2, y2 = pos[b]
        cx, cy, qx, qy = _arc(x1, y1, x2, y2, curve_cap)
        disp = _edge_display(g["pair_kinds"].get((a, b), []), w)
        edges.append({
            "a": a, "b": b,
            "x1": round(x1, 1), "y1": round(y1, 1),
            "x2": round(x2, 1), "y2": round(y2, 1),
            "cx": round(cx, 1), "cy": round(cy, 1),   # 贝塞尔控制点
            "mx": round(qx, 1), "my": round(qy, 1),   # 曲线中点(放标记符/标签)
            "w": w,
            "width": round(0.8 + 0.47 * abs(w), 2),
            **disp,
        })

    # 关键人物默认才标名字 —— 名字全开在人一多时会糊成一片。
    # 阈值取"重要性排进前 30% 或本身连接很多"的人。
    if nodes:
        ranked = sorted(nodes, key=lambda n: -n["r"])
        keep = max(3, round(len(ranked) * 0.3))
        key_ids = {n["id"] for n in ranked[:keep]}
        for n in nodes:
            n["key"] = bool(n["is_me"] or n["id"] in key_ids
                            or n["friends"] + n["enemies"] >= 5)

    circle = db.get_circle(circle_id) if circle_id else None
    payload = {
        "circle": circle,
        "bucket": bucket,
        "density": round(shrink, 3),   # 前端据此收敛光晕/星点强度
        "width": WIDTH, "height": HEIGHT,
        "nodes": nodes, "edges": edges,
        "faction_count": len(fac["factions"]),
        "version": db.graph_version(),
    }
    db.cache_put(cache_key, payload)
    return payload
