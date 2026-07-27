"""四大分析算法。全部手写,不引第三方图库。

百来号人的规模下,任何图算法都是毫秒级的,手写的好处是评分逻辑完全可控 ——
"谁值得拉拢"这种判断没有标准答案,必须能随时按实际情况调参。

四个功能:
  1. enemies_of_enemy   找敌人的敌人(可结盟名单)
  2. detect_factions    派系识别(Louvain 社区发现)
  3. key_people         关键人物(Brandes 中介中心性)
     intro_path         引荐路径(Dijkstra 最短路)
  4. unstable_triangles 不稳定三角(海德结构平衡理论)

两个汇总入口:brief(一个人的一屏简报)、situation(整个圈子的局势)。
它们都把自己那份 build_graph 结果用 g= 传给下面的算法 —— 每个算法各建
各的图的话,一次 brief 会跑 5 遍 build_graph、局势页会跑 4 遍加 2 遍
Brandes。所有算法的 g 都是**尾部可选参数**,不传就自己建,老调用零改动。
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

    **但求和有一个致命的边界情况**:正负恰好抵消时综合权重是 0,
    而 0 权重的边以前会被整条丢掉 —— 于是"朋友+2 且 竞争-2"这两个人
    在图上没有任何连线,在邻接表里也互不相识,派系聚类、中介中心性、
    引荐路径全都当他们不认识。

    可这恰恰是办公室政治里信息量最大的一种关系:**私交极好但工作上是对手**。
    它是结构洞所在,是最该被看见的东西,却成了唯一看不见的东西。

    所以除了 pair_w,这里另外分别累计正向分量和负向分量。综合权重仍然
    用于排序和强弱比较(那个语义是对的),而"这两人之间到底有没有关系"
    改由 pair_kinds 是否非空来回答。
    """
    people = {p["id"]: p for p in db.list_people(circle_id)}
    relations = db.list_relations(circle_id)

    pair_w = defaultdict(int)      # (min_id, max_id) -> 综合权重
    pair_pos = defaultdict(int)    # 同上 -> 正向分量之和
    pair_neg = defaultdict(int)    # 同上 -> 负向分量之和(<=0)
    pair_kinds = defaultdict(list)  # (min_id, max_id) -> [(kind, strength, directed, a, b)]

    for r in relations:
        a, b = r["a_id"], r["b_id"]
        if a not in people or b not in people:
            continue
        key = (min(a, b), max(a, b))
        pair_w[key] += r["strength"]
        if r["strength"] > 0:
            pair_pos[key] += r["strength"]
        elif r["strength"] < 0:
            pair_neg[key] += r["strength"]
        info = db.RELATION_KINDS.get(r["kind"], {})
        pair_kinds[key].append({
            "id": r["id"], "kind": r["kind"], "strength": r["strength"],
            "directed": r["directed"], "a_id": a, "b_id": b,
            "cat": info.get("cat", "社交"),
            "notes": r.get("notes", ""),
        })

    for k in list(pair_w):
        pair_w[k] = max(-3, min(3, pair_w[k]))
    for k in list(pair_pos):
        pair_pos[k] = min(3, pair_pos[k])
    for k in list(pair_neg):
        pair_neg[k] = max(-3, pair_neg[k])

    # 正负都有 = 混合关系(私交好但工作上是对手之类)。这类边综合权重
    # 可能恰好是 0,但两人显然是"认识且关系复杂",不能当不存在。
    mixed = {k for k in pair_kinds
             if pair_pos.get(k, 0) > 0 and pair_neg.get(k, 0) < 0}

    # 邻接表
    adj = defaultdict(dict)        # 全部有关系的边
    pos_adj = defaultdict(dict)    # 有正向分量的边
    neg_adj = defaultdict(dict)    # 有负向分量的边
    for (a, b) in pair_kinds:
        w = pair_w.get((a, b), 0)
        p = pair_pos.get((a, b), 0)
        n = pair_neg.get((a, b), 0)
        if w == 0 and (a, b) not in mixed:
            continue                # 真·中性关系(比如只录了一条 strength=0)
        # 综合权重为 0 的混合关系,在 adj 里取绝对值更大的那一侧当代表,
        # 免得最短路等算法拿到 0 权重除零
        aw = w if w != 0 else (p if p >= -n else n)
        adj[a][b] = aw
        adj[b][a] = aw
        # 关键:混合关系会**同时**进正表和负表 —— 这正是事实。
        # 以前一条边只能二选一,于是"我们私交很好"这半边信息直接消失。
        if p > 0:
            pos_adj[a][b] = p
            pos_adj[b][a] = p
        if n < 0:
            neg_adj[a][b] = n
            neg_adj[b][a] = n

    return {
        "circle_id": circle_id,
        "people": people,
        "pair_w": dict(pair_w),
        "pair_pos": dict(pair_pos),
        "pair_neg": dict(pair_neg),
        "mixed": mixed,
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


# 引荐链上每多经手一个人的固定摩擦(见 intro_path 的说明)
HOP_COST = 0.6
# 逆着有向关系的方向走要付的额外代价
REVERSE_COST = 1.8


def _direction_penalty(g, u, v):
    """从 u 走到 v 这一跳,是否逆着某条有向关系的方向。

    只看有方向的那些关系(db 里 directed=1 的 7 种)。a_id 那一侧是
    "师傅 / 提携者 / 上级 / 暗恋者 / 出借方",顺着这个方向托人办事更自然。
    一对人之间可能有多条关系,只要有任意一条是顺向的,就不算逆行。
    """
    kinds = g["pair_kinds"].get((min(u, v), max(u, v)))
    if not kinds:
        return 1.0
    directed = [k for k in kinds if k.get("directed") and k.get("strength", 0) > 0]
    if not directed:
        return 1.0
    if any(k["a_id"] == u for k in directed):
        return 1.0                  # 有一条是顺着走的
    return REVERSE_COST


# ============================================================
#  1. 找敌人的敌人
# ============================================================

def enemies_of_enemy(target_id, me_id=None, limit=30, circle_id=None, g=None):
    """给定目标 X,列出与 X 有矛盾、且我拉拢得动的人。

    score = 100 × conflict_n × reach_n × (0.70 + 0.20×clout_n + 0.10×(1-risk_n))

      conflict_n = conflict / 3          (0,1]  他跟目标的矛盾有多深
      reach_n    = (affinity+3) / 7.5    [0,1]  我够不够得着他
      clout_n    = 中介中心性归一化      [0,1]  他说话有多少分量
      risk_n     = min(1, 他跟我朋友们结的仇 / 6)  拉他会得罪自己人吗

    **为什么要换掉老的 `conflict × (3+affinity)`**:老公式的两个因子都是
    小整数(conflict 只有 1/2/3,affinity 多数时候是 0),乘出来的取值高度
    离散 —— 演示数据外的真实圈子里,常常六七个人分数一模一样。而
    `results.sort` 是稳定排序,同分时保留的是字典插入序,也就是**录入顺序**,
    可 UI 上它被呈现成"第一人选"。这是拿录入先后冒充判断,是误导。

    clout_n 是全式子里**唯一连续**的一项:它既把"谁更有份量"这个真实维度
    引进来,又顺手把同分打散了。risk_n 只占 10%,是修正项不是主项 ——
    "拉他会得罪我自己的朋友"值得扣分,但不该盖过"他跟目标矛盾有多深"。

    值域固定 0~100,可以当百分比直接讲给人听。

    **零点性质必须保住**:affinity == -3(我跟他也势不两立)→ reach_n == 0
    → 得 0 分。"我的敌人的敌人"如果同时也是我的死敌,他不会帮我 ——
    老公式靠 (3+affinity) 归零,新公式靠 reach_n 归零,含义完全一致。

    排序是显式全序 (-score, -conflict, -affinity, id),不依赖排序的稳定性,
    也就不再受录入顺序影响。
    """
    if g is None:
        g = build_graph(circle_id)
    if target_id not in g["people"]:
        return {"error": "找不到这个人"}

    me = db.get_me()
    if me_id is None and me:
        me_id = me["id"]

    # 中介中心性挂在 g 上缓存:局势页把同一个 g 传给好几个算法,
    # Brandes 只会跑一次
    bt = _betweenness(g)
    mx_bt = max(bt.values()) if bt else 0.0
    my_friends = set(g["pos_adj"].get(me_id, {})) if me_id else set()

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

        conflict_n = conflict / 3.0
        reach_n = (affinity + 3.0) / 7.5          # affinity 已钳到 [-3, 4.5]
        clout_n = (bt.get(pid, 0.0) / mx_bt) if mx_bt else 0.0
        # 他跟我的朋友们结了多少仇 —— 6 就封顶(两条 -3 已经很难收场了)
        risk_raw = sum(-w for z, w in g["neg_adj"].get(pid, {}).items()
                       if z in my_friends)
        risk_n = min(1.0, risk_raw / 6.0)
        score = 100.0 * conflict_n * reach_n * (
            0.70 + 0.20 * clout_n + 0.10 * (1.0 - risk_n))

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
            "clout": round(100 * clout_n, 1),
            "risk": round(risk_n, 2),
        })

    results.sort(key=lambda r: (-r["score"], -r["conflict"],
                                -r["affinity"], r["id"]))
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


def _faction_label(members, core):
    """给派系起个能说出口的名字。

    UI 上"#3 派系"等于什么都没说 —— 用户脑子里本来就有的说法只有两种:
    按部门("技术部那帮人")或者按头儿("陈国栋那一派")。主体部门占到
    六成就用部门,说明这一伙基本就是一个建制;不到六成说明是跨部门凑起来
    的,那部门名反而误导,只能用核心人物的名字。

    平局必须确定:两个部门人数一样多时用部门名做次级键。否则同一份数据
    换个字典遍历顺序就可能给出另一个名字,而这是要印在屏幕上的东西。

    六成的判定用整数乘法(count×5 >= total×3)而不是 count/total >= 0.6:
    0.6 在二进制里不精确,3/5 这种正好卡线的情况会被浮点误差判成不够。
    """
    depts = [m["dept"] for m in members if m.get("dept")]
    if depts:
        top = max(set(depts), key=lambda d: (depts.count(d), d))
        if depts.count(top) * 5 >= len(members) * 3:
            return f"{top}一系"
    if core and core.get("name"):
        return f"{core['name']}一派"
    return "散人"


def detect_factions(circle_id=None, g=None):
    """识别圈子,并标出每个圈子的核心和骑墙的人。

    只用正向关系聚类 —— 敌对关系不构成"一伙的"。
    """
    if g is None:
        g = build_graph(circle_id)
    nodes = list(g["people"].keys())
    pos_edges = {k: w for k, w in g["pair_w"].items() if w > 0}

    comm = _louvain(nodes, pos_edges)

    factions = defaultdict(list)
    for pid, c in comm.items():
        factions[c].append(pid)

    out = []
    # 次级键用社区号:同样大的两个派系谁排前面不能看 dict 的心情
    for cid, members in sorted(factions.items(),
                               key=lambda kv: (-len(kv[1]), kv[0])):
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
            "label": _faction_label(detail, core),
            "members": detail,
            "core": core,
            "straddlers": straddlers[:5],
        })

    # 圈子之间的敌对强度
    #
    # hostility 是一堆负强度加起来的无量纲数,印在屏幕上等于没印:
    # "7" 是多是少?占全局多大比重?到底几个人在掐?所以这里**只加字段
    # 不动 hostility 本身**,把同一件事翻译成能复述的话 ——
    # 几组人正面对上(fronts)、最深的一处多深(worst)、
    # 占全圈敌意的百分比(share)、最狠的那几对是谁(pairs)。
    tensions = []
    for i, j in itertools.combinations(range(len(out)), 2):
        set_i = {m["id"] for m in out[i]["members"]}
        set_j = {m["id"] for m in out[j]["members"]}
        cross = []
        for (a, b), w in g["pair_w"].items():
            if w < 0 and ((a in set_i and b in set_j) or (a in set_j and b in set_i)):
                # 让 a 永远来自 out[i] 那一派,"A方 ↔ B方"读起来才对得上
                if a in set_j:
                    a, b = b, a
                cross.append((a, b, w))
        if not cross:
            continue
        cross.sort(key=lambda e: (e[2], _name(g, e[0]), _name(g, e[1]), e[0], e[1]))
        tensions.append({
            "a": out[i]["id"], "b": out[j]["id"],
            "hostility": sum(-w for _, _, w in cross),
            "a_label": out[i]["label"], "b_label": out[j]["label"],
            "a_size": out[i]["size"], "b_size": out[j]["size"],
            "fronts": len(cross),
            "worst": max(-w for _, _, w in cross),
            "pairs": [{"a_id": a, "b_id": b, "a_name": _name(g, a),
                       "b_name": _name(g, b), "w": w}
                      for a, b, w in cross[:8]],
        })

    total_h = sum(t["hostility"] for t in tensions)
    for t in tensions:
        t["share"] = round(100.0 * t["hostility"] / total_h, 1) if total_h else 0.0

    # 显式全序。原来只按 -hostility 排,同分时靠 sort 的稳定性保留
    # itertools.combinations 的顺序,而那个顺序又取决于 factions 这个
    # defaultdict 的插入序 —— 等于让排名取决于录入顺序。
    tensions.sort(key=lambda t: (-t["hostility"], -t["fronts"], t["a"], t["b"]))

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


def _betweenness(g):
    """中介中心性,算完挂回 g 上。

    Brandes 是这里最贵的一步(O(V·E)),而现在有两个地方要用它:
    key_people 排名,和 enemies_of_enemy 的 clout 项。局势页两块都要,
    共用同一个 g 就只算一次。缓存挂在图快照上而不是模块级字典,是因为
    g 本身就代表"某个圈子在这一刻的样子",生命周期天然对得上,
    不需要额外的失效逻辑。
    """
    if "_bt" not in g:
        g["_bt"] = _brandes(list(g["people"].keys()), g["pos_adj"])
    return g["_bt"]


def key_people(limit=20, circle_id=None, g=None):
    """桥梁人物排行。"""
    if g is None:
        g = build_graph(circle_id)
    nodes = list(g["people"].keys())
    if not nodes:
        return {"people": []}

    bt = _betweenness(g)
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
    # 同分时用 id 兜底,免得"谁进 Top 20"取决于遍历顺序
    rows.sort(key=lambda r: (-r["betweenness"], r["id"]))
    return {"people": rows[:limit]}


def intro_path(from_id, to_id, circle_id=None, g=None):
    """我要接触某人,最短该托谁引荐。

    只走正向关系,边的代价 = 1/强度 —— 交情越铁,这一跳越"便宜",
    所以算法会优先选强关系链而不是单纯的短链。

    再加两条修正:

    **每跳的固定摩擦。** 只用 1/强度 时,三跳最强关系链(0.333×3=1.0)和
    一跳最弱关系(1.0)成本完全相同,而现实里每多一个人传话,成功率就要
    再打一次折。HOP_COST 让"少经手几个人"本身有价值。

    **方向。** 关系表里 7 种关系是有方向的(师徒、提携、上下级、单恋…),
    db 也一直忠实地存着 a/b 的顺序,但所有算法都把邻接表做成对称的,
    方向信息录进去了却从没被用过。引荐这件事上方向是实打实的:
    托师傅去说徒弟的事,和反过来,难度完全不一样。所以逆着方向走要加价。
    """
    if g is None:
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
            nd = d + HOP_COST + (1.0 / w) * _direction_penalty(g, u, v)
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

def unstable_triangles(limit=40, focus_id=None, circle_id=None, g=None):
    """找出结构上不稳定的三角关系。

    海德平衡理论:三条边的符号乘积为正则稳定,为负则不稳定。
      稳定  +++  三人皆友
      稳定  +--  我俩是朋友,共同讨厌第三个人
      不稳定 ++-  我的两个朋友互相敌视      ← 最容易撬动
      不稳定 ---  三人互相敌对(随时可能有两方联手)

    不稳定的三角是有张力的,局势最可能在这里翻转 —— 这就是"主要矛盾"
    的落点。撬动价值取三边强度绝对值之积:牵涉的情绪越强,翻盘影响越大。
    """
    if g is None:
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
    """针对一个目标的一屏简报 —— "谋划"页的主接口。

    这里一律把自己的 g 传下去。以前四个子分析各建各的图,一次 brief 要跑
    5 遍 build_graph;加上 enemies_of_enemy 现在还要 Brandes,不共用的话
    整个接口的成本会翻倍。
    """
    me = db.get_me()
    me_id = me["id"] if me else None
    g = build_graph(circle_id)
    if target_id not in g["people"]:
        return {"error": "找不到这个人"}

    fac = detect_factions(circle_id, g=g)
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
                                   circle_id=circle_id, g=g),
        "faction": tgt_faction,
        "same_faction_as_me": bool(
            my_faction and tgt_faction and my_faction["id"] == tgt_faction["id"]),
        "intro": intro_path(me_id, target_id, circle_id, g=g) if me_id else None,
        "triangles": unstable_triangles(limit=10, focus_id=target_id,
                                        circle_id=circle_id, g=g),
    }


# ============================================================
#  汇总:整个圈子的局势
# ============================================================

def _my_situation(g, fac):
    """我在这张图里的处境。返回 (数据块, 缺失原因)。

    "我是谁"没设过就返回 None,让前端出一个跳设置页的 CTA ——
    静默降级成一块空白比什么都不显示更糟,用户不知道是没数据还是坏了。
    me 设了但不在当前圈子里(比如新建的圈子还没把自己加进去)也返回 None,
    但 missing 是另一个值:两种情况该说的话不一样。
    """
    me = db.get_me()
    if not me:
        return None, "unset"
    me_id = me["id"]
    if me_id not in g["people"]:
        return None, "outside"

    my_fac = None
    for f in fac["factions"]:
        if any(m["id"] == me_id for m in f["members"]):
            my_fac = f
            break

    # 我这派正在跟谁对抗 —— tensions 已经排成全序了,取第一条牵扯到我的
    front = None
    if my_fac:
        for t in fac["tensions"]:
            mine_is_a = (t["a"] == my_fac["id"])
            if not mine_is_a and t["b"] != my_fac["id"]:
                continue
            front = {
                "faction_id": t["b"] if mine_is_a else t["a"],
                "label": t["b_label"] if mine_is_a else t["a_label"],
                "size": t["b_size"] if mine_is_a else t["a_size"],
                "share": t["share"],
                "fronts": t["fronts"],
                "worst": t["worst"],
                "pairs": t["pairs"],
            }
            break

    # 跟我作对的人:直接来自 neg_adj,不做任何推断
    rivals = [{"id": pid, "name": _name(g, pid),
               "dept": g["people"][pid].get("dept", ""), "w": w}
              for pid, w in g["neg_adj"].get(me_id, {}).items()]
    rivals.sort(key=lambda r: (r["w"], r["name"], r["id"]))

    bt = _betweenness(g)
    mine = bt.get(me_id, 0.0)
    mx = max(bt.values()) if bt else 0.0
    # 名次算成"比我高的人数 + 1"。用排序后找下标的话,同分时名次会取决于
    # 遍历顺序 —— 同一份数据可能一会儿第 5 一会儿第 7。
    rank = sum(1 for v in bt.values() if v > mine + 1e-9) + 1

    return {
        "id": me_id,
        "name": _name(g, me_id),
        "dept": g["people"][me_id].get("dept", ""),
        "faction": {
            "id": my_fac["id"],
            "label": my_fac["label"],
            "size": my_fac["size"],
            "core": my_fac["core"]["name"] if my_fac["core"] else "",
            "is_core": bool(my_fac["core"] and my_fac["core"]["id"] == me_id),
        } if my_fac else None,
        "front": front,
        "rivals": rivals,
        "rank": rank,
        "total": len(bt),
        "betweenness_pct": round(100.0 * mine / mx, 1) if mx else 0.0,
    }, None


def situation(circle_id=None):
    """局势页的全部数据:我 → 矛盾 → 人 → 下手处。

    五块数据分别走各自的接口的话,build_graph 要跑 4 遍、Brandes 要跑 2 遍。
    这里全程只建一次图、只算一次中介中心性,靠 g 参数传给每个算法。
    """
    g = build_graph(circle_id)
    fac = detect_factions(circle_id, g=g)
    me_block, missing = _my_situation(g, fac)
    return {
        "me": me_block,
        "me_missing": missing,
        "factions": fac["factions"],
        "tensions": fac["tensions"],
        "key_people": key_people(20, circle_id, g=g)["people"],
        "triangles": unstable_triangles(limit=8, circle_id=circle_id,
                                        g=g)["triangles"],
    }


# ============================================================
#  5. 传递推导 —— 给 AI 摄取用的"你是不是漏了这条"
# ============================================================

# 只有这两种关系适合做传递闭包:都是**无向**的(directed=0),
# 而且传递性在现实里真的成立(同一个住处 / 同一个班)。
#
# 明确排除的两个,理由不是保守,是算过的:
#   同事 —— 100 人公司同部门互推,一次就是几千条边,审核界面直接被淹掉;
#           而且"同部门"这个信息 roster 里本来就有,不需要推
#   家人 —— 传递性根本不成立:A 和 B 都是 C 的家人,两人可能只是姻亲
TRANSITIVE_KINDS = ("室友", "同学")

DERIVE_LIMIT = 8


def derive_transitive(circle_id, pending=None, kinds=TRANSITIVE_KINDS,
                      limit=DERIVE_LIMIT):
    """A—C 和 B—C 都是室友 → 建议 A—B 也是室友。

    返回**建议**,不写库 —— 结果会进 AI 摄取的审核界面,默认不勾选,
    由用户点头才入库。传递性在现实里只是"多半成立"(C 可能先后住过两个地方),
    所以它必须是建议而不是自动写入。

    pending:本次 AI 抽出来、还没入库的关系,形如
        [{"a_name": ..., "b_name": ..., "kind": ...}, ...]
    全程用**姓名**做键而不是 id:本次新抽到的人还没有 id。

    三条约束,少一条这个功能就会变成骚扰:
      1. 只提议**至少一端出现在本次录入里**的对 —— 否则每次录入都会把
         全库已有的闭包重新提一遍,而那些用户上次就已经看过并跳过了
      2. 只提议那一 kind **尚不存在**的对
      3. 按共同邻居数排序取前 limit 条 —— 共同邻居越多,推断越站得住
    """
    pending = pending or []
    out = []

    for kind in kinds:
        # 邻接表(姓名 → 姓名集合),库里已有的 + 本次待入库的一起算
        adj = {}
        have = set()          # 已经存在这一 kind 的对,归一成 (小, 大)

        def link(x, y):
            if not x or not y or x == y:
                return
            adj.setdefault(x, set()).add(y)
            adj.setdefault(y, set()).add(x)
            have.add((min(x, y), max(x, y)))

        for r in db.list_relations_detailed(circle_id):
            if r["kind"] == kind:
                link(r["a_name"], r["b_name"])
        touched = set()       # 本次录入涉及到的人
        for r in pending:
            touched.add(r.get("a_name"))
            touched.add(r.get("b_name"))
            if r.get("kind") == kind:
                link(r.get("a_name"), r.get("b_name"))
        touched.discard(None)

        # 找出所有"共同邻居 ≥1 但彼此还没连"的对
        cand = {}
        for mid, nbrs in adj.items():
            for a, b in itertools.combinations(sorted(nbrs), 2):
                key = (min(a, b), max(a, b))
                if key in have:
                    continue
                # 约束 1:与本次录入无关的对不提 —— 那些是历史遗留,
                # 用户上一次就已经看过并选择跳过了
                if a not in touched and b not in touched:
                    continue
                slot = cand.setdefault(key, {"vias": []})
                slot["vias"].append(mid)

        info = db.RELATION_KINDS.get(kind, {})
        for (a, b), slot in cand.items():
            vias = sorted(set(slot["vias"]))
            out.append({
                "a_name": a, "b_name": b,
                "kind": kind,
                "strength": info.get("default", 1),
                "cat": info.get("cat", "社交"),
                "glyph": db.CATEGORY_GLYPH.get(info.get("cat", "社交"), ""),
                "vias": vias,
                "derived": True,
                # 说明为什么会推出这条。**绝不能塞进 evidence** ——
                # 那个字段在界面上是当"原文引用"呈现的,把一句机器生成的话
                # 放进去就是在伪装成证据,而整个审核流程的价值恰恰建立在
                # "每条都附原文,扫一眼就知道它有没有编"上。
                "derived_note": (
                    f"{a} 和 {b} 都是 {'、'.join(vias[:3])} 的{kind}"
                    + ("等" if len(vias) > 3 else "")),
                "confidence": 0.5,
                "accepted": False,       # 默认不勾
            })

    # 共同邻居多的排前面;同分时按名字,保证结果可复现
    out.sort(key=lambda r: (-len(r["vias"]), r["a_name"], r["b_name"]))
    return out[:limit]
