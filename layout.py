"""力导向布局 —— 整个方案的性能关键。

常规的网页关系图是在浏览器里跑物理模拟循环:每秒几十帧,反复计算
每个节点受到的斥力和引力。这正是手机发热的来源。

这里把这一步整个搬到电脑上:服务端算出每个节点最终的 (x, y),
手机拿到的是一份已经排好版的静态坐标,只负责画。手机端没有任何
物理循环,平移缩放走 CSS transform 由 GPU 合成,CPU 基本闲置。

两个让重算尽量少发生的设计:
  - 结果按 graph_version 缓存,数据不变就不重算
  - 重算时以上一次的坐标为起点,只跑少量迭代,所以布局不会每次
    大变样(用户对图的空间记忆能保留),也快得多
"""

import json
import math
import random
from collections import defaultdict

import analysis
import db

WIDTH = 1000.0
HEIGHT = 1000.0

FULL_ITERATIONS = 300      # 冷启动(没有历史坐标)
WARM_ITERATIONS = 80       # 增量(有历史坐标,只需微调)

SEED_KEY = "layout_seed_positions"


def _load_seed():
    raw = db.get_meta(SEED_KEY)
    if not raw:
        return {}
    try:
        return {int(k): v for k, v in json.loads(raw).items()}
    except (json.JSONDecodeError, ValueError, TypeError):
        return {}


def _save_seed(pos):
    db.connect()
    with db.tx():
        db.set_meta(SEED_KEY, json.dumps(
            {str(k): [round(v[0], 2), round(v[1], 2)] for k, v in pos.items()}))


def compute(nodes, pos_adj, neg_adj, factions):
    """Fruchterman-Reingold 变体。

    在标准算法基础上加了两条针对"人际关系图"的规则:
      - 负向边额外产生斥力 —— 有矛盾的人在图上应该离得远
      - 同派系的人有轻微的额外引力 —— 圈子在视觉上抱团
    """
    n = len(nodes)
    if n == 0:
        return {}
    if n == 1:
        return {nodes[0]: (WIDTH / 2, HEIGHT / 2)}

    seed = _load_seed()
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


def get_graph_payload():
    """图谱视图要的全部数据 —— 坐标、颜色、粗细都已算好。

    手机端拿到后直接画,不做任何计算。
    """
    cached = db.cache_get("graph_payload")
    if cached is not None:
        return cached

    g = analysis.build_graph()
    people = g["people"]
    nodes_ids = sorted(people.keys())

    fac = analysis.detect_factions()
    faction_of = {int(k): v for k, v in fac["assignment"].items()}

    # 中介中心性决定节点大小 —— 一眼看出谁是绕不开的
    bt = analysis._brandes(nodes_ids, g["pos_adj"]) if nodes_ids else {}
    mx_bt = max(bt.values()) if bt else 0

    pos = compute(nodes_ids, g["pos_adj"], g["neg_adj"], faction_of)
    if pos:
        _save_seed(pos)

    nodes = []
    for pid in nodes_ids:
        p = people[pid]
        x, y = pos.get(pid, (WIDTH / 2, HEIGHT / 2))
        importance = (bt.get(pid, 0) / mx_bt) if mx_bt else 0.0
        nodes.append({
            "id": pid,
            "name": p["name"],
            "dept": p.get("dept", ""),
            "title": p.get("title", ""),
            "is_me": bool(p.get("is_me", 0)),
            "x": round(x, 1),
            "y": round(y, 1),
            "faction": faction_of.get(pid, 0),
            "r": round(8 + 14 * importance, 1),
            "friends": len(g["pos_adj"].get(pid, {})),
            "enemies": len(g["neg_adj"].get(pid, {})),
        })

    edges = []
    for (a, b), w in g["pair_w"].items():
        if w == 0 or a not in pos or b not in pos:
            continue
        kinds = [k["kind"] for k in g["pair_kinds"].get((a, b), [])]
        edges.append({
            "a": a, "b": b,
            "x1": round(pos[a][0], 1), "y1": round(pos[a][1], 1),
            "x2": round(pos[b][0], 1), "y2": round(pos[b][1], 1),
            "w": w,
            "width": round(1 + 1.2 * abs(w), 1),
            "kinds": kinds,
        })

    payload = {
        "width": WIDTH, "height": HEIGHT,
        "nodes": nodes, "edges": edges,
        "faction_count": len(fac["factions"]),
        "version": db.graph_version(),
    }
    db.cache_put("graph_payload", payload)
    return payload
