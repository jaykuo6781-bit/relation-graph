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
#
# 档位的**宽高比要对着「扣掉遮挡后的可用区」定,不是对着视口定**。
# computeFit 是按节点包围盒贴合的,而包围盒总会撑满画布,所以复位后的缩放
# 完全由「画布形状 vs 可用区形状」决定 —— 点云再均匀也改不了这个比值。
# 竖屏实测:390×844 的视口,扣掉名字余量、内边距和 AI 输入栏之后
# 可用区只有约 335×669(比 0.50),而旧的 760×1180 是比 0.644 ——
# 宽的那一维先顶住,高度方向白白浪费 22%,缩放卡在 0.45。
# 把竖屏档改成同样的 0.50,同一份点云的缩放就到 0.61。
ASPECT_BUCKETS = {
    "portrait": (560.0, 1120.0),   # 手机竖屏(比 0.50 = 手机可用区的形状)
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

# ---- 向心力:不再是拍脑袋的常数,而是按画布形状算出来的 ----
#
# 旧值是 GRAVITY = 0.055 一个数走天下,实测**弱了三十倍**,这才是
# "全贴四壁、中间一个大洞"的真正来源,加软墙、加抱团都只是隔靴搔痒。
#
# 推导:斥力是 k²/d,等价于每个节点带 k² 的"电荷"。一团均匀铺满
# 半轴 (a,b) 椭圆的二维电荷,内部产生的场是线性的:
#     E_x = 2σ·b/(a+b)·x,   σ = n·k²/(πab)
# 让它和线性向心力 G_x·x 平衡,再把 n·k² = 画布面积 = W·H 代进去:
#     G_x = 8H / (π(W+H)),  G_y = 8W / (π(W+H))
# 也就是说**向心力只取决于画布宽高比**,与人数、画布大小都无关 ——
# 这正是我们要的:19 人和 100 人的疏密观感一致。
# 代进 19 人竖屏(546×1092)得 G_x=1.70 / G_y=0.85,而旧代码是 0.055。
#
# 两个轴必须分开给。各向同性的重力配上 1:2 的画布,平衡态是个**圆**,
# 左右被硬边界削平(于是人贴在 x=20)、上下够不着(于是中间空)。
# 分轴之后平衡态才是和画布同比例的椭圆。
#
# GRAVITY_FILL 是目标椭圆相对画布的大小;略微过填(>1)让点云轻轻压住
# 四边,四角的格子才有人。GRAVITY_MAX 是稳定性上限:位移步长直接取
# 合力本身,纯重力下一步之后偏移量乘 (1-G),|1-G|<1 才收敛,
# G 必须小于 2;留出余量封在 1.5。
GRAVITY_FILL = 1.13
GRAVITY_MAX = 1.5


def _gravity(w, h):
    """按画布宽高比算出两个轴各自的向心力强度。"""
    s = 8.0 / (math.pi * (w + h) * GRAVITY_FILL * GRAVITY_FILL)
    return min(GRAVITY_MAX, s * h), min(GRAVITY_MAX, s * w)


# ---- 两阶段布局:先排派系,再排人 ----
#
# 单阶段 FR 在竖屏上会把点云挤成"左墙一堆 + 右墙一堆",中间两列全空
#(实测 19 人竖屏 4×4 网格里 8/16 格无人)。根因是 FR 只有两两之间的
# 局部力,没有任何东西决定"哪一坨该待在画布的哪个区域" —— 谁先被斥力
# 推到哪面墙谁就留在哪,而且往往顺着**短边**分开(19 人那份数据就是
# 左右分,画布明明是竖的),等于把最长的那一维浪费掉。
#
# 所以先给每个派系分一块画布,再让每个人从自己那块的中心附近出发,
# 主循环里给整个派系一个朝那块中心的**刚体平移力**。
# 副产品是派系在视觉上真的成团 —— 竖屏上现在是上中下三条带,一眼分得清。
#
# 分块用「按人数递归二分,每次切长边」,不是又跑一遍力导向。
# 力导向版本试过,失败得很典型:三个派系互相推开,在竖屏上摆成一个三角形,
# **中间四格全空**(4×4 网格 4/16 无人,而且空的正好是最显眼的正中央)。
# 互斥的点只会摊成一个环,永远填不满一个矩形。递归二分则是**构造性铺满**:
# 每一块都恰好是画布的一部分,加起来就是整块画布,不存在环形空洞。
#
# FACTION_ANCHOR 要给到 1.5 这个量级才有用。0.09 那种"轻推"完全推不动:
# 它要对抗的是别的派系加起来几百量级的斥力,而它自己只有
# 0.09×(质心偏移 ~190) ≈ 17。实测 0.09 和 0 的结果没有区别。
FACTION_ANCHOR = 1.5

# 正向边的引力倍数、负向边的额外斥力倍数。原来直接写在循环里,
# 提成常量是因为这两个数直接决定"抱团有多紧" —— 太紧就是几个实心球
# 加大片空白,太松就看不出派系。调它们要连着看两个指标:
# 网格空格数(铺得匀不匀)和派系内/派系间平均距离之比(团得像不像)。
# 引力降到 0.6 是因为派系的位置现在由分块决定了,不再需要靠边的引力
# 把一伙人拽到一起;实测降下来之后横屏档的空格从 6/16 掉到 2/16,
# 而派系内/间距离比只从 0.42 动到 0.40(照样团得很清楚)。
EDGE_PULL = 0.6
HOSTILE_PUSH = 0.8

# ---- 软墙 ----
# 坐标钳制是硬墙:越界就贴边。硬墙不给节点任何"别过来"的提示,
# 于是一排人叠在钳制线上(实测竖屏有 8 个人的圆心正好是 x=20)。
#
# 软墙用**镜像电荷**:墙外 dd 处当作有一个自己的镜像,按同一条 k²/d
# 的斥力公式推回来。这一点很关键 —— 试过按"离墙距离"线性推回,
# 系数怎么调都没用:斥力量级是 k²/d ≈ k(19 人竖屏 k≈177),
# 线性软墙给出的几十根本不在一个数量级上,人照样贴在 x=20。
# 力必须和斥力同一个量纲才治得住,所以这里所有系数都以 k 为单位。
# 减去边界处的值是为了让力在作用范围的边缘连续归零,不然会抖。
#
# 别以为向心力修好之后软墙就多余了。实测把 WALL_FORCE 关掉:
# 竖屏又有 8 个人、宽屏 10 个人的圆心正好落回钳制线,
# 复位缩放也从 0.636 掉回 0.615。两条都得留着。
WALL_MARGIN_K = 0.34      # 作用范围 = 理想边长 k 的这个倍数
WALL_MIN_K = 0.12         # 贴到墙上时的距离下限,防止力发散
WALL_FORCE = 0.85


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


def _load_seed(circle_id, bucket, w, h):
    """读上一次的坐标做暖启动。画布尺寸对不上就当没有。

    种子里存了当时的画布尺寸:改了档位尺寸(或人数跨了缩放档)之后,
    旧坐标落在另一个尺寸的画布里,暖启动会把它们原地钳到新边界上,
    结果比冷启动还糟 —— 一整排人贴在新的边界线上,而且只有 80 次迭代
    来收拾残局。宁可多花一次冷启动。
    旧版种子是扁平的 {id: [x, y]},没有尺寸可比,一并丢弃。
    """
    raw = db.get_meta(_seed_key(circle_id, bucket))
    if not raw:
        return {}
    try:
        data = json.loads(raw)
        if not isinstance(data, dict) or "pos" not in data:
            return {}
        if abs(float(data.get("w", 0)) - w) > 1.0 or \
           abs(float(data.get("h", 0)) - h) > 1.0:
            return {}
        return {int(k): v for k, v in data["pos"].items()}
    except (json.JSONDecodeError, ValueError, TypeError, AttributeError):
        return {}


def _save_seed(circle_id, bucket, pos, w, h):
    db.connect()
    with db.tx():
        db.set_meta(_seed_key(circle_id, bucket), json.dumps({
            "w": round(w, 1), "h": round(h, 1),
            "pos": {str(k): [round(v[0], 2), round(v[1], 2)]
                    for k, v in pos.items()},
        }))


def _groups_of(nodes, factions):
    """把节点按派系分组。没有派系号的人归到 -1 那一组。

    统一成 int 是因为后面要 sorted() —— Python 3 里 None 和 int 不能比大小,
    而排序必须稳定,否则同一份数据两次算出来的图会不一样。
    """
    gof, groups = {}, defaultdict(list)
    for v in nodes:
        c = factions.get(v)
        c = -1 if c is None else int(c)
        gof[v] = c
        groups[c].append(v)
    return gof, groups


def _cross_affinity(gof, pos_adj, neg_adj):
    """派系两两之间的亲疏:跨派正向边算亲,负向边算疏,返回净值。"""
    aff = defaultdict(float)
    for adj, sign in ((pos_adj, 1.0), (neg_adj, -1.0)):
        for v, nbrs in adj.items():
            if v not in gof:
                continue
            for u, w in nbrs.items():
                if u not in gof or v >= u or gof[v] == gof[u]:
                    continue
                aff[(min(gof[v], gof[u]), max(gof[v], gof[u]))] += sign * abs(w)
    return aff


def _order_factions(gids, groups, aff):
    """给派系排一个一维顺序:关系好的排在一起。

    分块是按这个顺序依次切下去的,相邻的两块在画布上也相邻,
    所以顺序就等于"谁和谁挨着画"。从最大的派系起头,每次贪心地接上
    与刚放下那个最亲的 —— 敌对的自然被推到序列两端,也就是画布两头。
    并列时用人数、再用派系号兜底,保证同一份数据每次结果完全一样。
    """
    rest = sorted(gids, key=lambda g: (-len(groups[g]), g))
    order = [rest.pop(0)]
    while rest:
        last = order[-1]
        rest.sort(key=lambda g: (-aff.get((min(last, g), max(last, g)), 0.0),
                                 -len(groups[g]), g))
        order.append(rest.pop(0))
    return order


def _tile(order, weight, x, y, w, h, out):
    """按权重把矩形递归二分,每次切较长的那条边,块矩形写进 out。

    这是 treemap 的"切片"变体。选切点时取最接近对半的那个分割,
    切出来的块才不会细成一条 —— 细长条会让派系被压成一条线,
    和"贴在墙上"一样难看。
    """
    if len(order) == 1:
        out[order[0]] = (x, y, w, h)
        return
    total = sum(weight[g] for g in order)
    acc, cut, frac, best = 0.0, 1, weight[order[0]] / total, None
    for i in range(1, len(order)):
        acc += weight[order[i - 1]]
        d = abs(acc / total - 0.5)
        if best is None or d < best:
            best, cut, frac = d, i, acc / total
    if w >= h:
        _tile(order[:cut], weight, x, y, w * frac, h, out)
        _tile(order[cut:], weight, x + w * frac, y, w * (1 - frac), h, out)
    else:
        _tile(order[:cut], weight, x, y, w, h * frac, out)
        _tile(order[cut:], weight, x, y + h * frac, w, h * (1 - frac), out)


def _faction_tiles(gof, groups, pos_adj, neg_adj, W, H):
    """第一阶段:给每个派系分一块画布,返回 {派系号: (x, y, w, h)}。

    只有一个派系时返回空 dict —— 没什么可排的,主循环照原样跑。
    """
    gids = sorted(groups)
    if len(gids) < 2:
        return {}
    weight = {g: float(len(groups[g])) for g in gids}
    order = _order_factions(gids, groups, _cross_affinity(gof, pos_adj, neg_adj))
    out = {}
    _tile(order, weight, 0.0, 0.0, W, H, out)
    return out


def _spread_in(rect, m, i):
    """把一个派系的第 i 个人(共 m 个)撒在它那块矩形里,近似均匀。

    按块的宽高比选行列数,块是竖的就多排几行,不会把人排成一条线。

    别指望这一步能决定最终形态:实测把迭代数从 300 拉到 1200,结果一个像素
    都不变 —— 这套力场是收敛的,初值只影响收敛快慢,不影响落点。
    它真正的价值是**冷启动少走弯路**:起点已经在自己那一块里,
    不用先被斥力甩到画布另一头再被锚定力拽回来。
    """
    x, y, w, h = rect
    cols = max(1, int(round(math.sqrt(m * w / h)))) if h > 0 else m
    cols = min(cols, m)
    rows = int(math.ceil(m / cols))
    r, c = divmod(i, cols)
    # 最后一行不满时把它居中,免得右下角空一块
    in_row = m - r * cols if r == rows - 1 else cols
    inset = 0.14
    fx = (c + 0.5) / in_row if in_row > 0 else 0.5
    fy = (r + 0.5) / rows
    return (x + w * (inset + (1 - 2 * inset) * fx),
            y + h * (inset + (1 - 2 * inset) * fy))


def compute(nodes, pos_adj, neg_adj, factions, circle_id=None,
            bucket=DEFAULT_BUCKET):
    """Fruchterman-Reingold 变体,两阶段。

    第一阶段(_faction_tiles):按人数把画布分给各派系。
    第二阶段(下面这个循环):在标准 FR 的斥力/引力之外再加三条规则 ——
      - 负向边额外产生斥力 —— 有矛盾的人在图上应该离得远
      - 每个派系整体朝自己那一块平移 —— 圈子在视觉上抱团,而且抱在该在的地方
      - 分轴向心力 + 软墙 —— 点云铺成和画布同比例的形状,不堆在边界线上
    """
    n = len(nodes)
    WIDTH, HEIGHT = canvas_of(bucket, n)
    if n == 0:
        return {}
    if n == 1:
        return {nodes[0]: (WIDTH / 2, HEIGHT / 2)}

    seed = _load_seed(circle_id, bucket, WIDTH, HEIGHT)
    # 固定随机种子:同一份数据每次算出来的图是一样的,不会随机跳动
    rng = random.Random(20260101)

    gof, groups = _groups_of(nodes, factions)
    tiles = _faction_tiles(gof, groups, pos_adj, neg_adj, WIDTH, HEIGHT)
    targets = {g: (t[0] + t[2] / 2, t[1] + t[3] / 2) for g, t in tiles.items()}
    idx_in_grp = {v: i for m in groups.values() for i, v in enumerate(m)}

    pos = {}
    warm = 0
    for i, v in enumerate(nodes):
        if v in seed and isinstance(seed[v], (list, tuple)) and len(seed[v]) == 2:
            pos[v] = [float(seed[v][0]), float(seed[v][1])]
            warm += 1
            continue
        rect = tiles.get(gof[v])
        if rect:
            m = groups[gof[v]]
            sx, sy = _spread_in(rect, len(m), idx_in_grp[v])
            pos[v] = [sx + rng.uniform(-6, 6), sy + rng.uniform(-6, 6)]
        else:
            # 只有一个派系(或压根没有派系信息):撒在圆周上,
            # 至少避免所有新点重叠在中心
            ang = 2 * math.pi * i / n
            r = 0.35 * min(WIDTH, HEIGHT)
            pos[v] = [WIDTH / 2 + r * math.cos(ang) + rng.uniform(-20, 20),
                      HEIGHT / 2 + r * math.sin(ang) + rng.uniform(-20, 20)]

    iterations = WARM_ITERATIONS if warm >= n * 0.8 else FULL_ITERATIONS

    area = WIDTH * HEIGHT
    k = math.sqrt(area / n)          # 理想边长
    temp = WIDTH / 10.0
    cooling = temp / (iterations + 1)

    # 每轮循环都用得上、但和迭代无关的量,提到外面算一次
    cx0, cy0 = WIDTH / 2, HEIGHT / 2
    gx, gy = _gravity(WIDTH, HEIGHT)
    kk = k * k
    wall_r = WALL_MARGIN_K * k
    wall_min = WALL_MIN_K * k
    wall_f0 = kk / wall_r

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

                force = kk / d
                # 有矛盾的人额外推开,强度越大推得越远
                nw = neg_adj.get(vi, {}).get(vj)
                if nw:
                    force *= (1.0 + HOSTILE_PUSH * abs(nw))

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
                force = EDGE_PULL * (d * d) / k * (0.5 + 0.35 * w)
                fx, fy = force * dx / d, force * dy / d
                disp[v][0] -= fx; disp[v][1] -= fy
                disp[u][0] += fx; disp[u][1] += fy

        # --- 向心力(分轴,强度由所在区块的形状定,见文件头 _gravity)---
        # Fruchterman-Reingold 原版只有斥力和引力,没有任何把节点拉回来的力,
        # 结果所有点一路往外飘直到撞上边界钳制 —— 表现就是"全贴在四壁上,
        # 中间空一个大洞"。
        # 向心的目标必须是**画布中心**。试过"每个派系各拉向自己那块的中心",
        # 直觉上更该铺满,实际错得很明显:那条平衡公式只配平了本块里的电荷,
        # 而每个人还受着别块所有人的斥力,那部分完全没人抵消 ——
        # 实测 8 个人的块宽 410,人却全挤在 x<180,照样贴着画布左墙。
        for v in nodes:
            disp[v][0] -= (pos[v][0] - cx0) * gx
            disp[v][1] -= (pos[v][1] - cy0) * gy

        # --- 派系整体朝自己那一块靠拢 ---
        # 用的是"**派系质心**与块中心的差",不是"我与块中心的差" ——
        # 后者对每个人各推一个不同的量,等于把整派压向一个点;
        # 前者对全派是同一个矢量,是刚体平移,内部结构和密度一点不动,
        # 因此不会破坏上面那条平衡关系。
        if targets:
            centers = defaultdict(lambda: [0.0, 0.0, 0])
            for v in nodes:
                c = gof[v]
                centers[c][0] += pos[v][0]
                centers[c][1] += pos[v][1]
                centers[c][2] += 1
            shift = {}
            for c, (sx, sy, cnt) in centers.items():
                t = targets.get(c)
                if t:
                    shift[c] = ((sx / cnt - t[0]) * FACTION_ANCHOR,
                                (sy / cnt - t[1]) * FACTION_ANCHOR)
            for v in nodes:
                s2 = shift.get(gof[v])
                if s2:
                    disp[v][0] -= s2[0]
                    disp[v][1] -= s2[1]

        # --- 软墙(镜像斥力,见文件头 WALL_MARGIN_K 的注释)---
        for v in nodes:
            p = pos[v]
            if p[0] < wall_r:
                disp[v][0] += WALL_FORCE * (kk / max(p[0], wall_min) - wall_f0)
            elif p[0] > WIDTH - wall_r:
                disp[v][0] -= WALL_FORCE * (
                    kk / max(WIDTH - p[0], wall_min) - wall_f0)
            if p[1] < wall_r:
                disp[v][1] += WALL_FORCE * (kk / max(p[1], wall_min) - wall_f0)
            elif p[1] > HEIGHT - wall_r:
                disp[v][1] -= WALL_FORCE * (
                    kk / max(HEIGHT - p[1], wall_min) - wall_f0)

        # --- 位移(受温度限制)+ 边界约束 ---
        # 钳制留着当最后一道保险(selftest 断言坐标必须在画布内),
        # 但有了软墙之后正常情况下已经碰不到它了。
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


def _edge_display(kinds, w, mixed=False):
    """决定一条边怎么显示:标签取最强的那个关系,标记符取它的类别。

    混合关系(既有正向又有负向)单独标出来 —— 它是这张图上信息量最大的
    一种边:两个人私交很好但利益上是对手。前端据此画成双色。
    """
    if not kinds:
        return {"label": "", "cat": "社交", "glyph": "", "count": 0,
                "mixed": False}
    dominant = max(kinds, key=lambda k: abs(k.get("strength", 0)))
    cat = dominant.get("cat", "社交")
    if mixed:
        # 混合边的标签要同时点出两面,只显示"最强的那个"会误导 ——
        # 强度相同时(朋友+2 / 竞争-2)取哪个纯属偶然
        pos_k = max((k for k in kinds if k.get("strength", 0) > 0),
                    key=lambda k: k["strength"], default=None)
        neg_k = min((k for k in kinds if k.get("strength", 0) < 0),
                    key=lambda k: k["strength"], default=None)
        if pos_k and neg_k:
            return {
                "label": f"{pos_k['kind']} / {neg_k['kind']}",
                "cat": cat,
                "glyph": "⚡",              # 张力
                "count": len(kinds),
                "all_kinds": [k["kind"] for k in kinds],
                "mixed": True,
            }
    return {
        "label": dominant["kind"],
        "cat": cat,
        "glyph": db.CATEGORY_GLYPH.get(cat, ""),
        "count": len(kinds),
        "all_kinds": [k["kind"] for k in kinds],
        "mixed": False,
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
        _save_seed(circle_id, bucket, pos, WIDTH, HEIGHT)

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
    mixed_pairs = g.get("mixed") or set()
    # 遍历 pair_kinds 而不是 pair_w:综合权重为 0 的混合关系
    # (朋友+2 且 竞争-2)在 pair_w 里是 0,以前会被整条丢掉,
    # 于是这两个人在图上看起来毫无关系 —— 而那恰恰是最该被看见的一种关系。
    for (a, b), kinds in g["pair_kinds"].items():
        if a not in pos or b not in pos:
            continue
        w = g["pair_w"].get((a, b), 0)
        is_mixed = (a, b) in mixed_pairs
        if w == 0 and not is_mixed:
            continue                 # 真·中性,没什么可画的
        x1, y1 = pos[a]
        x2, y2 = pos[b]
        cx, cy, qx, qy = _arc(x1, y1, x2, y2, curve_cap)
        disp = _edge_display(kinds, w, is_mixed)
        pw = g.get("pair_pos", {}).get((a, b), 0)
        nw = g.get("pair_neg", {}).get((a, b), 0)
        # 粗细按"这段关系有多重",混合边取两个分量里更强的那个,
        # 不能用综合权重 —— 那是 0,线会细得看不见
        mag = max(abs(w), abs(pw), abs(nw))
        edges.append({
            "a": a, "b": b,
            "x1": round(x1, 1), "y1": round(y1, 1),
            "x2": round(x2, 1), "y2": round(y2, 1),
            "cx": round(cx, 1), "cy": round(cy, 1),   # 贝塞尔控制点
            "mx": round(qx, 1), "my": round(qy, 1),   # 曲线中点(放标记符/标签)
            "w": w,
            "pw": pw, "nw": nw,                       # 正/负分量,前端画双色用
            "width": round(0.8 + 0.47 * mag, 2),
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
