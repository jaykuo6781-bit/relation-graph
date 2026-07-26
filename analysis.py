"""四大分析算法。全部手写,不引第三方图库。

百来号人的规模下,任何图算法都是毫秒级的,手写的好处是评分逻辑完全可控 ——
"谁值得拉拢"这种判断没有标准答案,必须能随时按实际情况调参。

四个功能:
  1. enemies_of_enemy   找敌人的敌人(可结盟名单)
  2. detect_factions    派系识别(Louvain 社区发现)
  3. key_people         关键人物(Brandes 中介中心性)
     intro_path         引荐路径(Dijkstra 最短路)
  4. unstable_triangles 不稳定三角(海德结构平衡理论)
"""

import heapq
import itertools
import math
from collections import defaultdict

import db


# ============================================================
#  图快照 —— 所有算法的共同输入
# ============================================================

def build_graph(circle_id=None):
    """把某个圈子里的关系压成一张带符号权重的图。

    circle_id=None 表示合并全部圈子(总览视图)。

    一对人之间可能同时存在多种关系(比如既是"上下级"又是"竞争"),
    这里把强度相加再截断到 [-3,3] 作为这条边的综合权重。相加是对的:
    "朋友+2" 叠加 "竞争-1" 得 +1,正好表达"关系不错但有竞争"。
    """
    people = {p["id"]: p for p in db.list_people(circle_id)}
    relations = db.list_relations(circle_id)

    pair_w = defaultdict(int)      # (min_id, max_id) -> 综合权重
    pair_kinds = defaultdict(list)  # (min_id, max_id) -> [(kind, strength, directed, a, b)]

    for r in relations:
        a, b = r["a_id"], r["b_id"]
        if a not in people or b not in people:
            continue
        key = (min(a, b), max(a, b))
        pair_w[key] += r["strength"]
        info = db.RELATION_KINDS.get(r["kind"], {})
        pair_kinds[key].append({
            "id": r["id"], "kind": r["kind"], "strength": r["strength"],
            "directed": r["directed"], "a_id": a, "b_id": b,
            "cat": info.get("cat", "社交"),
            "notes": r.get("notes", ""),
        })

    for k in list(pair_w):
        pair_w[k] = max(-3, min(3, pair_w[k]))

    # 邻接表
    adj = defaultdict(dict)        # 全部非零边
    pos_adj = defaultdict(dict)    # 只有正向边
    neg_adj = defaultdict(dict)    # 只有负向边
    for (a, b), w in pair_w.items():
        if w == 0:
            continue
        adj[a][b] = w
        adj[b][a] = w
        if w > 0:
            pos_adj[a][b] = w
            pos_adj[b][a] = w
        else:
            neg_adj[a][b] = w
            neg_adj[b][a] = w

    return {
        "circle_id": circle_id,
        "people": people,
        "pair_w": dict(pair_w),
        "pair_kinds": dict(pair_kinds),
        "adj": adj,
        "pos_adj": pos_adj,
        "neg_adj": neg_adj,
    }


def _w(g, a, b):
    return g["pair_w"].get((min(a, b), max(a, b)), 0)


def _name(g, pid):
    p = g["people"].get(pid)
    return p["name"] if p else f"#{pid}"


# ============================================================
#  1. 找敌人的敌人
# ============================================================

def enemies_of_enemy(target_id, me_id=None, limit=30, circle_id=None):
    """给定目标 X,列出与 X 有矛盾、且我拉拢得动的人。

    评分 = 矛盾烈度 × 可拉拢度

    矛盾烈度 conflict:  1..3,来自 Y 与 X 的负向权重
    可拉拢度 affinity:  我与 Y 的直接关系 + 共同好友带来的间接可达性
                        为负说明 Y 跟我也不对付,分数会被压下去

    score = conflict × (3 + affinity),affinity=-3 时归零,
    也就是"我的敌人的敌人"不会被推荐 —— 这是对的,他不会帮我。
    """
    g = build_graph(circle_id)
    if target_id not in g["people"]:
        return {"error": "找不到这个人"}

    me = db.get_me()
    if me_id is None and me:
        me_id = me["id"]

    results = []
    for pid in g["people"]:
        if pid == target_id or pid == me_id:
            continue
        w_to_target = _w(g, pid, target_id)
        if w_to_target >= 0:
            continue                       # 跟目标没矛盾,跳过

        conflict = -w_to_target            # 1..3

        # --- 可拉拢度 ---
        direct = 0
        bridge_via, bridge_score = None, 0
        if me_id:
            direct = _w(g, me_id, pid)
            # 最好的一条二跳路径:我 —— Z —— 他,取瓶颈最强的那条
            for z, w_me_z in g["pos_adj"].get(me_id, {}).items():
                if z in (pid, target_id):
                    continue
                w_z_p = g["pos_adj"].get(z, {}).get(pid, 0)
                if w_z_p > 0:
                    b = min(w_me_z, w_z_p)
                    if b > bridge_score:
                        bridge_score, bridge_via = b, z

        affinity = direct + 0.5 * bridge_score
        affinity = max(-3.0, min(4.5, affinity))
        score = conflict * (3 + affinity)

        conflict_kinds = [
            k["kind"] for k in
            g["pair_kinds"].get((min(pid, target_id), max(pid, target_id)), [])
            if k["strength"] < 0
        ]

        if me_id is None:
            approach = "未设置「我是谁」,无法计算拉拢路径"
        elif direct > 0:
            approach = f"我跟他直接有交情(强度 {direct})"
        elif direct < 0:
            approach = f"⚠ 我跟他也有矛盾(强度 {direct}),不好拉"
        elif bridge_via:
            approach = f"可以托 {_name(g, bridge_via)} 引荐"
        else:
            approach = "目前没有可用的接触路径"

        results.append({
            "id": pid,
            "name": _name(g, pid),
            "dept": g["people"][pid].get("dept", ""),
            "score": round(score, 2),
            "conflict": conflict,
            "conflict_kinds": conflict_kinds or ["利益冲突"],
            "affinity": round(affinity, 2),
            "direct": direct,
            "bridge_via": _name(g, bridge_via) if bridge_via else None,
            "approach": approach,
        })

    results.sort(key=lambda r: -r["score"])
    return {
        "target": {"id": target_id, "name": _name(g, target_id)},
        "me": {"id": me_id, "name": _name(g, me_id)} if me_id else None,
        "candidates": results[:limit],
    }


# ============================================================
#  2. 派系识别 —— Louvain 社区发现
# ============================================================

def _louvain(nodes, edges):
    """Louvain 社区发现。

    edges: {(a,b): weight}  权重必须为正。
    返回 {node: community_id}。

    标准两阶段:先让每个节点贪心地移动到能最大化模块度增益的邻居社区,
    收敛后把每个社区聚合成一个超级节点,在新图上重复,直到没有改进。
    """
    if not edges:
        return {n: i for i, n in enumerate(nodes)}

    # 当前层的图
    cur_nodes = list(nodes)
    cur_edges = dict(edges)
    # 每个原始节点属于当前层的哪个节点
    node_to_super = {n: n for n in nodes}

    while True:
        adj = defaultdict(dict)
        self_loops = defaultdict(float)
        for (a, b), w in cur_edges.items():
            if a == b:
                self_loops[a] += w
            else:
                adj[a][b] = adj[a].get(b, 0) + w
                adj[b][a] = adj[b].get(a, 0) + w

        m2 = sum(cur_edges.values()) * 2  # 2m
        if m2 <= 0:
            break

        comm = {n: n for n in cur_nodes}
        # k_i:节点 i 的加权度(含自环 ×2)
        k = {n: sum(adj[n].values()) + 2 * self_loops[n] for n in cur_nodes}
        sum_tot = {n: k[n] for n in cur_nodes}

        improved_any = False
        for _ in range(20):                      # 局部移动最多迭代 20 轮
            improved = False
            for n in cur_nodes:
                c_old = comm[n]
                sum_tot[c_old] -= k[n]

                # 到各邻居社区的连边权重
                links = defaultdict(float)
                for nb, w in adj[n].items():
                    links[comm[nb]] += w

                best_c, best_gain = c_old, links.get(c_old, 0) - sum_tot[c_old] * k[n] / m2
                for c, w_in in links.items():
                    gain = w_in - sum_tot[c] * k[n] / m2
                    if gain > best_gain + 1e-12:
                        best_c, best_gain = c, gain

                sum_tot[best_c] += k[n]
                comm[n] = best_c
                if best_c != c_old:
                    improved = improved_any = True
            if not improved:
                break

        if not improved_any:
            break

        # --- 聚合 ---
        # 社区编号重新连续化
        remap, nxt = {}, 0
        for n in cur_nodes:
            if comm[n] not in remap:
                remap[comm[n]] = nxt
                nxt += 1
        comm = {n: remap[c] for n, c in comm.items()}

        if nxt == len(cur_nodes):
            break                                # 没合并动,收工

        node_to_super = {orig: comm[sup] for orig, sup in node_to_super.items()}

        new_edges = defaultdict(float)
        for (a, b), w in cur_edges.items():
            ca, cb = comm[a], comm[b]
            new_edges[(min(ca, cb), max(ca, cb))] += w
        cur_edges = dict(new_edges)
        cur_nodes = list(range(nxt))

    return node_to_super


def detect_factions(circle_id=None):
    """识别圈子,并标出每个圈子的核心和骑墙的人。

    只用正向关系聚类 —— 敌对关系不构成"一伙的"。
    """
    g = build_graph(circle_id)
    nodes = list(g["people"].keys())
    pos_edges = {k: w for k, w in g["pair_w"].items() if w > 0}

    comm = _louvain(nodes, pos_edges)

    factions = defaultdict(list)
    for pid, c in comm.items():
        factions[c].append(pid)

    out = []
    for cid, members in sorted(factions.items(), key=lambda kv: -len(kv[1])):
        if len(members) < 1:
            continue
        member_set = set(members)

        detail = []
        for pid in members:
            inside = sum(w for nb, w in g["pos_adj"].get(pid, {}).items()
                         if nb in member_set)
            outside = sum(w for nb, w in g["pos_adj"].get(pid, {}).items()
                          if nb not in member_set)
            total = inside + outside
            # 参与系数:对外连接占比越高越像骑墙的
            straddle = (outside / total) if total > 0 else 0.0
            detail.append({
                "id": pid,
                "name": _name(g, pid),
                "dept": g["people"][pid].get("dept", ""),
                "inside": inside,
                "outside": outside,
                "straddle": round(straddle, 2),
            })

        detail.sort(key=lambda d: -d["inside"])
        core = detail[0] if detail else None
        straddlers = [d for d in detail if d["straddle"] >= 0.4 and d["outside"] > 0]
        straddlers.sort(key=lambda d: -d["straddle"])

        out.append({
            "id": cid,
            "size": len(members),
            "members": detail,
            "core": core,
            "straddlers": straddlers[:5],
        })

    # 圈子之间的敌对强度
    tensions = []
    for i, j in itertools.combinations(range(len(out)), 2):
        set_i = {m["id"] for m in out[i]["members"]}
        set_j = {m["id"] for m in out[j]["members"]}
        hostility = 0
        for (a, b), w in g["pair_w"].items():
            if w < 0 and ((a in set_i and b in set_j) or (a in set_j and b in set_i)):
                hostility += -w
        if hostility > 0:
            tensions.append({
                "a": out[i]["id"], "b": out[j]["id"], "hostility": hostility,
            })
    tensions.sort(key=lambda t: -t["hostility"])

    return {"factions": out, "tensions": tensions,
            "assignment": {str(k): v for k, v in comm.items()}}


# ============================================================
#  3. 关键人物 / 引荐路径
# ============================================================

def _brandes(nodes, adj):
    """Brandes 中介中心性(无权版,按最短跳数)。

    衡量"绕不开"的程度:有多少对人之间的最短联络路径必须经过此人。
    """
    cb = {n: 0.0 for n in nodes}
    for s in nodes:
        stack, preds = [], {n: [] for n in nodes}
        sigma = {n: 0.0 for n in nodes}
        dist = {n: -1 for n in nodes}
        sigma[s], dist[s] = 1.0, 0
        queue = [s]
        qi = 0
        while qi < len(queue):
            v = queue[qi]; qi += 1
            stack.append(v)
            for w in adj.get(v, {}):
                if dist[w] < 0:
                    dist[w] = dist[v] + 1
                    queue.append(w)
                if dist[w] == dist[v] + 1:
                    sigma[w] += sigma[v]
                    preds[w].append(v)
        delta = {n: 0.0 for n in nodes}
        while stack:
            w = stack.pop()
            for v in preds[w]:
                delta[v] += (sigma[v] / sigma[w]) * (1 + delta[w])
            if w != s:
                cb[w] += delta[w]
    # 无向图每对被数了两次
    for n in cb:
        cb[n] /= 2.0
    return cb


def key_people(limit=20, circle_id=None):
    """桥梁人物排行。"""
    g = build_graph(circle_id)
    nodes = list(g["people"].keys())
    if not nodes:
        return {"people": []}

    bt = _brandes(nodes, g["pos_adj"])
    mx = max(bt.values()) if bt else 0

    rows = []
    for pid in nodes:
        pos_deg = len(g["pos_adj"].get(pid, {}))
        neg_deg = len(g["neg_adj"].get(pid, {}))
        rows.append({
            "id": pid,
            "name": _name(g, pid),
            "dept": g["people"][pid].get("dept", ""),
            "betweenness": round(bt.get(pid, 0), 2),
            "betweenness_pct": round(100 * bt.get(pid, 0) / mx, 1) if mx else 0.0,
            "friends": pos_deg,
            "enemies": neg_deg,
        })
    rows.sort(key=lambda r: -r["betweenness"])
    return {"people": rows[:limit]}


def intro_path(from_id, to_id, circle_id=None):
    """我要接触某人,最短该托谁引荐。

    只走正向关系,边的代价 = 1/强度 —— 交情越铁,这一跳越"便宜",
    所以算法会优先选强关系链而不是单纯的短链。
    """
    g = build_graph(circle_id)
    if from_id not in g["people"] or to_id not in g["people"]:
        return {"error": "找不到这个人"}
    if from_id == to_id:
        return {"path": [{"id": from_id, "name": _name(g, from_id)}], "cost": 0}

    dist = {from_id: 0.0}
    prev = {}
    pq = [(0.0, from_id)]
    visited = set()

    while pq:
        d, u = heapq.heappop(pq)
        if u in visited:
            continue
        visited.add(u)
        if u == to_id:
            break
        for v, w in g["pos_adj"].get(u, {}).items():
            if w <= 0:
                continue
            nd = d + 1.0 / w
            if nd < dist.get(v, math.inf):
                dist[v] = nd
                prev[v] = u
                heapq.heappush(pq, (nd, v))

    if to_id not in dist:
        return {"path": None,
                "reason": "沿正向关系走不通 —— 目前没有人能把你引荐过去"}

    chain, cur = [], to_id
    while cur != from_id:
        chain.append(cur)
        cur = prev[cur]
    chain.append(from_id)
    chain.reverse()

    steps = []
    for i, pid in enumerate(chain):
        step = {"id": pid, "name": _name(g, pid),
                "dept": g["people"][pid].get("dept", "")}
        if i > 0:
            step["via_strength"] = _w(g, chain[i - 1], pid)
        steps.append(step)

    return {"path": steps, "cost": round(dist[to_id], 2), "hops": len(chain) - 1}


# ============================================================
#  4. 不稳定三角(海德结构平衡理论)
# ============================================================

def unstable_triangles(limit=40, focus_id=None, circle_id=None):
    """找出结构上不稳定的三角关系。

    海德平衡理论:三条边的符号乘积为正则稳定,为负则不稳定。
      稳定  +++  三人皆友
      稳定  +--  我俩是朋友,共同讨厌第三个人
      不稳定 ++-  我的两个朋友互相敌视      ← 最容易撬动
      不稳定 ---  三人互相敌对(随时可能有两方联手)

    不稳定的三角是有张力的,局势最可能在这里翻转 —— 这就是"主要矛盾"
    的落点。撬动价值取三边强度绝对值之积:牵涉的情绪越强,翻盘影响越大。
    """
    g = build_graph(circle_id)
    adj = g["adj"]
    nodes = sorted(adj.keys())

    seen = set()
    out = []
    for v in nodes:
        nbrs = [n for n in adj[v] if n > v]
        for a, b in itertools.combinations(nbrs, 2):
            if b not in adj[a]:
                continue
            tri = tuple(sorted((v, a, b)))
            if tri in seen:
                continue
            seen.add(tri)
            if focus_id is not None and focus_id not in tri:
                continue

            x, y, z = tri
            e = [(x, y, _w(g, x, y)), (y, z, _w(g, y, z)), (x, z, _w(g, x, z))]
            if any(w == 0 for _, _, w in e):
                continue

            sign_product = 1
            for _, _, w in e:
                sign_product *= (1 if w > 0 else -1)
            if sign_product > 0:
                continue                     # 稳定,跳过

            leverage = 1
            for _, _, w in e:
                leverage *= abs(w)

            n_pos = sum(1 for _, _, w in e if w > 0)
            if n_pos == 2:
                pattern = "两个朋友互相敌视"
                hint_edge = min((x for x in e if x[2] < 0), key=lambda t: abs(t[2]))
                hint = (f"最省力的撬点:{_name(g, hint_edge[0])} 与 "
                        f"{_name(g, hint_edge[1])} 的矛盾(强度 {hint_edge[2]})"
                        f",这条边最弱,最容易调和或激化")
            else:
                pattern = "三人互相敌对"
                hint_edge = max(e, key=lambda t: t[2])
                hint = (f"最省力的撬点:{_name(g, hint_edge[0])} 与 "
                        f"{_name(g, hint_edge[1])} 的敌意最轻(强度 {hint_edge[2]})"
                        f",最有希望争取过来联手")

            out.append({
                "members": [{"id": p, "name": _name(g, p)} for p in tri],
                "edges": [{"a": a_, "b": b_, "a_name": _name(g, a_),
                           "b_name": _name(g, b_), "w": w} for a_, b_, w in e],
                "pattern": pattern,
                "leverage": leverage,
                "hint": hint,
            })

    out.sort(key=lambda t: -t["leverage"])
    return {"triangles": out[:limit], "total": len(out)}


# ============================================================
#  汇总:一个人的全套分析
# ============================================================

def brief(target_id, circle_id=None):
    """针对一个目标的一屏简报 —— "谋划"页的主接口。"""
    me = db.get_me()
    me_id = me["id"] if me else None
    g = build_graph(circle_id)
    if target_id not in g["people"]:
        return {"error": "找不到这个人"}

    fac = detect_factions(circle_id)
    my_faction = tgt_faction = None
    for f in fac["factions"]:
        ids = {m["id"] for m in f["members"]}
        if target_id in ids:
            tgt_faction = f
        if me_id and me_id in ids:
            my_faction = f

    return {
        "target": {
            "id": target_id,
            "name": _name(g, target_id),
            "dept": g["people"][target_id].get("dept", ""),
            "title": g["people"][target_id].get("title", ""),
        },
        "allies": enemies_of_enemy(target_id, me_id, limit=10,
                                   circle_id=circle_id),
        "faction": tgt_faction,
        "same_faction_as_me": bool(
            my_faction and tgt_faction and my_faction["id"] == tgt_faction["id"]),
        "intro": intro_path(me_id, target_id, circle_id) if me_id else None,
        "triangles": unstable_triangles(limit=10, focus_id=target_id,
                                        circle_id=circle_id),
    }
