"""算法自检。

demo_seed.json 里的关系不是随手编的:它预埋了已知的派系结构、已知的引荐
路径、已知的不稳定三角,以及一组跨圈子的对照(同两个人在公司圈和同学圈
里是不同的关系)。见该文件的 `_expected` 字段。

这个脚本拿那些预设值当标准答案逐条核对,而不是"程序没报错就算过"。

跑法:  python selftest.py

测试跑在临时数据库上,不会碰你的真实数据。
"""

import json
import os
import random
import sys
import tempfile
from pathlib import Path

# Windows 上一旦输出被重定向(管道、重定向到文件、SSH),Python 会退回
# cp1252,遇到中文直接抛 UnicodeEncodeError —— 测试本身没问题,却看不到结果。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# 必须在 import config 之前设置 —— 全程用临时库
_TMP_DB = Path(tempfile.gettempdir()) / "relgraph_selftest.db"
for p in (_TMP_DB, Path(str(_TMP_DB) + "-wal"), Path(str(_TMP_DB) + "-shm")):
    if p.exists():
        p.unlink()
os.environ["RELGRAPH_DB"] = str(_TMP_DB)

import analysis  # noqa: E402
import db        # noqa: E402
import layout    # noqa: E402

PASS, FAIL = [], []


def check(label, ok, detail=""):
    (PASS if ok else FAIL).append(label)
    print(f"  {'✓' if ok else '✗'} {label}")
    if detail and not ok:
        print(f"      {detail}")


def main():
    seed_path = Path(__file__).resolve().parent / "demo_seed.json"
    seed = json.loads(seed_path.read_text(encoding="utf-8"))

    print("\n载入演示数据…")
    stats = db.import_all(seed, replace=True)
    me = db.find_person_by_name(seed["me"])
    if me:
        db.set_me(me["id"])
    print(f"  {stats['circles']} 个圈子 / {stats['people']} 人 / "
          f"{stats['relations']} 条关系 / {stats['events']} 条事件\n")

    circles = {c["name"]: c for c in db.list_circles()}
    company = circles.get("公司圈")
    klass = circles.get("同学圈")

    # ---------------- 载入 ----------------
    print("数据载入")
    check("两个圈子都建好了", len(circles) == 2, f"实际:{list(circles)}")
    check("人数正确(25)", stats["people"] == 25, f"实际 {stats['people']}")
    check("关系数正确(52)", stats["relations"] == 52,
          f"实际 {stats['relations']}")
    check("已标记「我」", db.get_me() is not None)
    if not (company and klass):
        print("\n圈子缺失,后续用例无法进行"); return 1

    check("公司圈 19 人", company["people"] == 19, f"实际 {company['people']}")
    check("同学圈 8 人", klass["people"] == 8, f"实际 {klass['people']}")
    check("公司圈 40 条关系", company["relations"] == 40,
          f"实际 {company['relations']}")
    check("同学圈 12 条关系", klass["relations"] == 12,
          f"实际 {klass['relations']}")

    # ---------------- 跨圈子(本轮的核心改动) ----------------
    print("\n跨圈子隔离")
    su = db.find_person_by_name("苏明哲")
    lin = db.find_person_by_name("林子豪")

    all_pair = db.find_relations_between(su["id"], lin["id"])
    in_company = db.find_relations_between(su["id"], lin["id"], company["id"])
    in_class = db.find_relations_between(su["id"], lin["id"], klass["id"])

    check("苏明哲和林子豪一共有两条关系(两个圈子各一条)",
          len(all_pair) == 2,
          f"实际 {[(r['circle_name'], r['kind']) for r in all_pair]}")
    check("公司圈里他俩是「朋友」",
          len(in_company) == 1 and in_company[0]["kind"] == "朋友",
          f"实际 {[r['kind'] for r in in_company]}")
    check("同学圈里他俩是「死党」",
          len(in_class) == 1 and in_class[0]["kind"] == "死党",
          f"实际 {[r['kind'] for r in in_class]}")

    check("苏明哲全库只有一条人员记录",
          len([p for p in db.list_people() if p["name"] == "苏明哲"]) == 1)
    check("苏明哲同时属于两个圈子",
          len(db.circles_of(su["id"])) == 2,
          f"实际 {[c['name'] for c in db.circles_of(su['id'])]}")

    company_names = {p["name"] for p in db.list_people(company["id"])}
    class_names = {p["name"] for p in db.list_people(klass["id"])}
    check("公司圈里看不到只属于同学圈的人",
          "温若琳" not in company_names and "邵一鸣" not in company_names)
    check("同学圈里看不到只属于公司圈的人",
          "陈国栋" not in class_names and "周文彬" not in class_names)

    # ---------------- 公司圈:v1 的结论必须继续成立 ----------------
    print("\n公司圈(v1 的结论不能回归)")
    cid = company["id"]
    fac = analysis.detect_factions(cid)
    big = [f for f in fac["factions"] if f["size"] >= 3]
    check("聚出 3 个主要圈子", len(big) == 3,
          f"实际 {[f['size'] for f in fac['factions']]}")

    cores = {f["core"]["name"] for f in big if f["core"]}
    for nm in ("陈国栋", "周文彬", "许宏伟"):
        check(f"{nm} 是某个派系的核心", nm in cores, f"实际 {cores}")

    straddlers = {s["name"] for f in fac["factions"] for s in f["straddlers"]}
    check("林子豪被标为骑墙者", "林子豪" in straddlers, f"实际 {straddlers}")

    zhou = db.find_person_by_name("周文彬")
    path = analysis.intro_path(su["id"], zhou["id"], cid)
    names = [s["name"] for s in (path.get("path") or [])]
    check("苏明哲 → 周文彬 经由林子豪",
          names == ["苏明哲", "林子豪", "周文彬"],
          f"实际 {' → '.join(names) if names else '走不通'}")

    allies = analysis.enemies_of_enemy(zhou["id"], su["id"], circle_id=cid)
    top = allies["candidates"][0]["name"] if allies["candidates"] else None
    check("以周文彬为目标,第一人选是陈国栋", top == "陈国栋",
          f"实际 {[c['name'] for c in allies['candidates'][:5]]}")

    tri_c = analysis.unstable_triangles(limit=100, circle_id=cid)
    got_c = {frozenset(m["name"] for m in t["members"])
             for t in tri_c["triangles"]}
    for members, label in (
        ({"苏明哲", "李明远", "王海涛"}, "我的两个朋友互相敌视"),
        ({"林子豪", "陈国栋", "周文彬"}, "骑墙者的困境"),
        ({"陈国栋", "周文彬", "许宏伟"}, "三巨头互相敌对"),
    ):
        check(f"公司圈找到不稳定三角:{label}", frozenset(members) in got_c)

    # ---------------- 局势页:派系名字与可复述的矛盾(v6) ----------------
    print("\n局势页:派系有名字,矛盾能复述")
    check("每个派系都有非空名字(UI 上不能再出现「#3 派系」)",
          all(f.get("label") for f in fac["factions"]),
          f"实际 {[f.get('label') for f in fac['factions']]}")
    by_core = {f["core"]["name"]: f for f in fac["factions"] if f["core"]}
    check("主体部门过六成的派系按部门起名",
          by_core.get("陈国栋", {}).get("label") == "技术部一系",
          f"实际 {by_core.get('陈国栋', {}).get('label')!r}")
    # 财务派是 5 个人里 3 个财务部 —— 正好卡在六成线上,把 >= 写成 > 就翻
    check("刚好卡在六成线上的派系也按部门起名(判据是 ≥ 不是 >)",
          by_core.get("许宏伟", {}).get("label") == "财务部一系",
          f"实际 {by_core.get('许宏伟', {}).get('label')!r}")

    TEN = fac["tensions"]
    need = ("a_label", "b_label", "a_size", "b_size",
            "fronts", "worst", "share", "pairs")
    check("tensions 字段齐全(裸 hostility 印在屏幕上等于没印)",
          bool(TEN) and all(all(k in t for k in need) for t in TEN),
          f"缺 {[k for k in need if TEN and k not in TEN[0]]}")
    check("share 加起来是 100%",
          98 <= sum(t["share"] for t in TEN) <= 102,
          f"实际 {sum(t['share'] for t in TEN)}")
    check("worst 落在 1..3(它要被翻译成「势不两立」这种词)",
          all(1 <= t["worst"] <= 3 for t in TEN))
    check("pairs 恰好是 fronts 截到前 8 —— 少一条就是漏了一组对立",
          all(len(t["pairs"]) == min(t["fronts"], 8) for t in TEN),
          f"实际 {[(t['fronts'], len(t['pairs'])) for t in TEN]}")
    fmem = {f["id"]: {m["id"] for m in f["members"]} for f in fac["factions"]}
    # 把 a/b 装反了屏幕上照样是一句通顺的话,只有断言能抓
    check("pairs 里 a_name 一定来自 a 那一派,「A方 ↔ B方」不会读反",
          all(p["a_id"] in fmem[t["a"]] and p["b_id"] in fmem[t["b"]]
              for t in TEN for p in t["pairs"]))
    check("pairs 按狠度排,最深的一处在最前面",
          all([p["w"] for p in t["pairs"]] ==
              sorted(p["w"] for p in t["pairs"]) for t in TEN))

    ordk_t = lambda t: (-t["hostility"], -t["fronts"], t["a"], t["b"])  # noqa: E731
    check("矛盾按声明的全序排,不靠字典插入序",
          [ordk_t(t) for t in TEN] == sorted(ordk_t(t) for t in TEN))
    sig = lambda d: [(t["a"], t["b"], t["hostility"]) for t in d["tensions"]]  # noqa: E731
    check("连跑两次 detect_factions,矛盾的顺序和数值完全一致",
          sig(fac) == sig(analysis.detect_factions(cid)),
          f"实际 {sig(fac)}")

    # 只有真出现平局,排序确定性才测得出来。造三个派系:
    #   大派(4 人) vs 中派(3 人):一条 -3      → 敌意 3,1 组人对上
    #   大派(4 人) vs 小派(2 人):-1 加 -2      → 敌意 3,2 组人对上
    # 两边敌意总量一样,而 itertools.combinations 天然把「大 vs 中」排在前面。
    # 只按 -hostility 排(稳定排序)就会保留那个顺序,战线更多的反而靠后。
    tie_c = db.create_circle("_矛盾平局测试", "自定义")
    tp = {n: db.upsert_person(n, circle_id=tie_c)[0] for n in
          ("大一测", "大二测", "大三测", "大四测",
           "中一测", "中二测", "中三测", "小一测", "小二测")}
    for x, y in (("大一测", "大二测"), ("大一测", "大三测"), ("大一测", "大四测"),
                 ("中一测", "中二测"), ("中一测", "中三测"), ("小一测", "小二测")):
        db.upsert_relation(tie_c, tp[x], tp[y], "朋友", 3)
    db.upsert_relation(tie_c, tp["大一测"], tp["中一测"], "敌对", -3)
    db.upsert_relation(tie_c, tp["大二测"], tp["小一测"], "竞争", -1)
    db.upsert_relation(tie_c, tp["大三测"], tp["小二测"], "利益冲突", -2)
    tf = analysis.detect_factions(tie_c)
    tt = tf["tensions"]
    check("平局场景确实构造出来了(三个派系、两组敌意相等的矛盾)",
          len(tf["factions"]) == 3 and len(tt) == 2
          and tt[0]["hostility"] == tt[1]["hostility"] == 3,
          f"实际 {[(t['hostility'], t['fronts']) for t in tt]}")
    check("敌意总量打平时,战线更多的那组排前面",
          [t["fronts"] for t in tt] == [2, 1],
          f"实际 {[t['fronts'] for t in tt]} —— 只按 -hostility 排就是 [1, 2]")
    check("平局时的顺序符合声明的全序",
          [ordk_t(t) for t in tt] == sorted(ordk_t(t) for t in tt))
    check("平局时两次运行给出同一个顺序",
          [(t["a"], t["b"]) for t in analysis.detect_factions(tie_c)["tensions"]]
          == [(t["a"], t["b"]) for t in tt])
    check("没有部门可依据时改用核心人物起名",
          all(f["label"].endswith("一派") for f in tf["factions"]),
          f"实际 {[f['label'] for f in tf['factions']]}")
    db.delete_circle(tie_c)
    for pid in tp.values():
        db.delete_person(pid)

    # ---------------- 关键人物榜 ----------------
    print("\n关键人物榜(README 宣传了四年,前端一直够不着)")
    krows = analysis.key_people(30, cid)["people"]
    check("榜首的中介中心性就是 100%",
          bool(krows) and krows[0]["betweenness_pct"] == 100.0,
          f"实际 {krows[0]['betweenness_pct'] if krows else None}")
    check("中介中心性单调不增",
          all(krows[i]["betweenness"] >= krows[i + 1]["betweenness"]
              for i in range(len(krows) - 1)))
    check("百分比和绝对值同向(不会一个降一个升)",
          all(krows[i]["betweenness_pct"] >= krows[i + 1]["betweenness_pct"]
              for i in range(len(krows) - 1)))

    lin = db.find_person_by_name("林子豪")
    keyf = lambda t: frozenset(m["id"] for m in t["members"])  # noqa: E731
    tri_all = analysis.unstable_triangles(limit=999, circle_id=cid)
    tri_foc = analysis.unstable_triangles(limit=999, focus_id=lin["id"],
                                          circle_id=cid)
    want = {keyf(t) for t in tri_all["triangles"] if lin["id"] in keyf(t)}
    check("林子豪确实卷在不稳定三角里(不然下面两条是白测的)", bool(want))
    check("focus 的三角恰好是全局结果里含他的那些",
          {keyf(t) for t in tri_foc["triangles"]} == want,
          f"focus {len(tri_foc['triangles'])} / 全局含他 {len(want)}")
    check("focus 查询的 total 也只数含他的那些",
          tri_foc["total"] == len(want),
          f"实际 {tri_foc['total']} vs {len(want)}")

    # ---------------- 可结盟评分:换掉大面积同分的老公式(v6) ----------------
    print("\n可结盟评分:把同分打散")
    cands = allies["candidates"]
    check("评分值域 0~100(可以当百分比直接说)",
          all(0 <= c["score"] <= 100 for c in cands),
          f"实际 {[c['score'] for c in cands]}")
    ordk_c = lambda r: (-r["score"], -r["conflict"],           # noqa: E731
                        -r["affinity"], r["id"])
    shuffled = list(cands)
    random.Random(20260726).shuffle(shuffled)
    check("打乱后按声明的全序重排,序列与函数输出逐个相同",
          [r["id"] for r in sorted(shuffled, key=ordk_c)] ==
          [r["id"] for r in cands],
          "analysis 里的 sort key 跟这里声明的不是同一个 —— 排名不可复现")

    # 造一个"大面积同分"的场景:5 个人跟靶子的矛盾一样深、跟我一样没交情。
    # 旧公式 conflict×(3+affinity) 给他们一模一样的分,而 UI 上排第一的那个
    # 会被读成"第一人选" —— 那其实只是录入顺序。
    sc = db.create_circle("_同分测试", "自定义")
    tgt = db.upsert_person("靶子测", circle_id=sc)[0]
    my = db.upsert_person("我方测", circle_id=sc)[0]
    hub = db.upsert_person("枢纽测", circle_id=sc)[0]
    cand_ids, leaf_ids = [], []
    for i in range(1, 6):
        c = db.upsert_person(f"候选{i}测", circle_id=sc)[0]
        cand_ids.append(c)
        db.upsert_relation(sc, c, tgt, "敌对", -2)      # 矛盾深度全一样
        db.upsert_relation(sc, hub, c, "朋友", 2)
        for j in range(i):                              # 跟班数各不相同 ——
            leaf = db.upsert_person(f"跟班{i}{j}测", circle_id=sc)[0]
            leaf_ids.append(leaf)                       # 中介中心性因此互不相等
            db.upsert_relation(sc, c, leaf, "朋友", 1)
    foe = db.upsert_person("死敌测", circle_id=sc)[0]
    db.upsert_relation(sc, foe, tgt, "敌对", -2)
    db.upsert_relation(sc, my, foe, "敌对", -3)         # 我跟他也势不两立

    # 再放两个各方面完全对称的人:新公式也必然给他们同一个分数。
    # 名字故意让 SQLite 的 ORDER BY dept,name 把「乙」排在「甲」前面
    # (乙 U+4E59 < 甲 U+7532),而 id 是甲小 —— 于是"按 id 兜底"和
    # "保留遍历顺序"会给出**相反**的结果,下面那条重排用例才测得出东西。
    even_a = db.upsert_person("甲同分测", circle_id=sc)[0]
    even_b = db.upsert_person("乙同分测", circle_id=sc)[0]
    for pid in (even_a, even_b):
        db.upsert_relation(sc, pid, tgt, "敌对", -2)

    res = analysis.enemies_of_enemy(tgt, my, circle_id=sc)["candidates"]
    new_scores = [c["score"] for c in res]
    old_scores = [round(c["conflict"] * (3 + c["affinity"]), 2) for c in res]
    new_rate = len(set(new_scores)) / len(new_scores)
    old_rate = len(set(old_scores)) / len(old_scores)
    check("这个场景下旧公式确实大面积同分(否则这组用例是白测的)",
          old_rate < 1.0, f"旧公式区分度 {old_rate:.2f}")
    check("新公式的区分度严格优于旧公式",
          new_rate > old_rate, f"新 {new_rate:.2f} / 旧 {old_rate:.2f}")
    check("打散同分靠的是 clout,它在这五个人身上各不相同",
          len({c["clout"] for c in res if c["id"] in cand_ids}) == len(cand_ids),
          f"实际 {[(c['name'], c['clout']) for c in res]}")
    zero = [c for c in res if c["id"] == foe]
    check("affinity == -3(我跟他也势不两立)时得 0 分,零点性质没丢",
          len(zero) == 1 and zero[0]["affinity"] == -3 and zero[0]["score"] == 0,
          f"实际 {zero}")
    check("合成场景里评分也不越出 0~100",
          all(0 <= c["score"] <= 100 for c in res))
    even = [c for c in res if c["id"] in (even_a, even_b)]
    check("完全对称的两个人得分确实相同(否则下一条测不到平局)",
          len(even) == 2 and even[0]["score"] == even[1]["score"],
          f"实际 {[(c['name'], c['score']) for c in even]}")
    check("真出现平局时按 id 兜底,不保留遍历顺序",
          [c["id"] for c in even] == [even_a, even_b],
          f"实际 {[c['name'] for c in even]} —— 只按 -score 排的话是反的")
    shuf2 = list(res)
    random.Random(31337).shuffle(shuf2)
    check("合成场景打乱后重排,序列也与函数输出逐个相同",
          [r["id"] for r in sorted(shuf2, key=ordk_c)] == [r["id"] for r in res])

    # ---------------- 局势页汇总:共享 g 不能算出不一样的结果 ----------------
    print("\n局势页汇总")
    sit = analysis.situation(cid)
    check("五块齐全",
          all(k in sit for k in
              ("me", "factions", "tensions", "key_people", "triangles")),
          f"实际 {list(sit)}")
    check("共享同一个 g 算出来的三块,与各自单独跑逐字相同",
          sit["factions"] == analysis.detect_factions(cid)["factions"]
          and sit["tensions"] == analysis.detect_factions(cid)["tensions"]
          and sit["key_people"] == analysis.key_people(20, cid)["people"]
          and sit["triangles"] == analysis.unstable_triangles(
              limit=8, circle_id=cid)["triangles"],
          "共用 g 时有算法把它改坏了")
    check("我的处境里带派系、对手名单和绕不开程度排名",
          sit["me"] and sit["me"]["faction"]["label"]
          and isinstance(sit["me"]["rivals"], list)
          and 1 <= sit["me"]["rank"] <= sit["me"]["total"],
          f"实际 {sit['me']}")
    check("我这派正在对抗的那一方,不是我自己这派",
          sit["me"]["front"] is None
          or sit["me"]["front"]["faction_id"] != sit["me"]["faction"]["id"],
          f"实际 {sit['me']['front']}")
    # 共享 g 唯一的作用是省时间,输出一模一样 —— 所以只能靠数调用次数来钉。
    # 不钉的话哪天有人顺手把 g= 删掉,测试全绿,接口悄悄慢一倍。
    calls = {"graph": 0, "brandes": 0}
    _bg, _br = analysis.build_graph, analysis._brandes

    def _count_bg(*a, **k):
        calls["graph"] += 1
        return _bg(*a, **k)

    def _count_br(*a, **k):
        calls["brandes"] += 1
        return _br(*a, **k)

    analysis.build_graph, analysis._brandes = _count_bg, _count_br
    try:
        analysis.situation(cid)
        sit_calls = dict(calls)
        calls.update(graph=0, brandes=0)
        analysis.brief(zhou["id"], cid)
        brief_calls = dict(calls)
    finally:
        analysis.build_graph, analysis._brandes = _bg, _br
    check("局势页全程只建一次图、只跑一次 Brandes",
          sit_calls == {"graph": 1, "brandes": 1}, f"实际 {sit_calls}")
    check("brief 也只建一次图(以前是 5 次)",
          brief_calls == {"graph": 1, "brandes": 1}, f"实际 {brief_calls}")

    sit_sc = analysis.situation(sc)
    check("圈子里没有我时 me 是 null 而不是崩",
          sit_sc["me"] is None and sit_sc["me_missing"] == "outside",
          f"实际 me={sit_sc['me']} missing={sit_sc['me_missing']}")
    sc_headcount = len(db.list_people(sc))
    check("关键人物只给 Top 20(这个圈子人比 20 多)",
          sc_headcount > 20 and len(sit_sc["key_people"]) == 20,
          f"圈内 {sc_headcount} 人,榜单 {len(sit_sc['key_people'])} 条")
    # 结果要原样进 layout_cache(json.dumps),而 g 里躺着一个 set(mixed)。
    # 哪天不小心把它漏出去,接口只会在缓存未命中的那一次 500 —— 本地看不出来。
    try:
        json.dumps(sit, ensure_ascii=False)
        ser_ok, ser_err = True, ""
    except TypeError as e:
        ser_ok, ser_err = False, str(e)
    check("局势页结果能直接 json 序列化(cache_put 要用)", ser_ok, ser_err)

    db.delete_circle(sc)
    for pid in ([tgt, my, hub, foe, even_a, even_b] + cand_ids + leaf_ids):
        db.delete_person(pid)

    # ---------------- 同学圈:情感关系 ----------------
    print("\n同学圈(情感关系)")
    kid = klass["id"]
    shao = db.find_person_by_name("邵一鸣")
    bai = db.find_person_by_name("白宇航")
    wen = db.find_person_by_name("温若琳")

    rivals = db.find_relations_between(shao["id"], bai["id"], kid)
    check("邵一鸣和白宇航是情敌",
          len(rivals) == 1 and rivals[0]["kind"] == "情敌",
          f"实际 {[r['kind'] for r in rivals]}")
    check("情敌属于「情感」类别",
          db.RELATION_KINDS["情敌"]["cat"] == "情感")
    check("情敌是负向关系", rivals and rivals[0]["strength"] < 0)

    lonely = db.find_relations_between(shao["id"], wen["id"], kid)
    check("单恋是有方向的,且方向是 邵一鸣 → 温若琳",
          len(lonely) == 1 and lonely[0]["directed"] == 1
          and lonely[0]["a_id"] == shao["id"],
          f"实际 {lonely}")

    tri_k = analysis.unstable_triangles(limit=100, circle_id=kid)
    got_k = {frozenset(m["name"] for m in t["members"])
             for t in tri_k["triangles"]}
    check("同学圈找到不稳定三角:我的室友和我的朋友是情敌",
          frozenset({"苏明哲", "邵一鸣", "白宇航"}) in got_k,
          f"实际找到 {[sorted(s) for s in got_k]}")

    check("公司圈的三角里不会混进同学圈的人",
          not any({"邵一鸣", "白宇航", "温若琳"} & s for s in got_c))
    check("同学圈的三角里不会混进公司圈独有的人",
          not any({"陈国栋", "周文彬", "许宏伟"} & s for s in got_k))

    stories = db.events_for_pair(shao["id"], bai["id"], kid)
    check("能查到邵一鸣和白宇航之间的故事", len(stories) >= 1,
          f"实际 {len(stories)} 条")

    # ---------------- 混合关系不该消失(v6 修复) ----------------
    print("\n混合关系(既是朋友又是对手)")
    mix_c = db.create_circle("_混合测试", "自定义")
    ja, _ = db.upsert_person("甲测", circle_id=mix_c)
    jb, _ = db.upsert_person("乙测", circle_id=mix_c)
    db.upsert_relation(mix_c, ja, jb, "朋友", 2)
    db.upsert_relation(mix_c, ja, jb, "竞争", -2)
    gm = analysis.build_graph(mix_c)
    kk = (min(ja, jb), max(ja, jb))

    check("综合权重确实是 0(正负恰好抵消)", gm["pair_w"][kk] == 0,
          f"实际 {gm['pair_w'][kk]}")
    check("被识别为混合关系", kk in gm["mixed"])
    check("两人在邻接表里是相连的(以前这里断开)",
          jb in gm["adj"].get(ja, {}),
          "综合权重为 0 就被丢掉的话,派系/中心性/引荐全都当他们不认识")
    check("同时进正向表和负向表 —— 这正是事实",
          jb in gm["pos_adj"].get(ja, {}) and jb in gm["neg_adj"].get(ja, {}))
    pm = layout.get_graph_payload(mix_c)
    me_edge = [e for e in pm["edges"] if {e["a"], e["b"]} == {ja, jb}]
    check("图上真的画出了这条边", len(me_edge) == 1,
          "以前 w==0 会被 layout 跳过,两个人看起来毫无关系")
    if me_edge:
        e = me_edge[0]
        check("边被标为 mixed 且带 ⚡ 标记符",
              e.get("mixed") and e.get("glyph") == "⚡",
              f"实际 mixed={e.get('mixed')} glyph={e.get('glyph')!r}")
        check("标签同时点出两面,而不是只显示其中一个",
              "朋友" in e["label"] and "竞争" in e["label"],
              f"实际 {e['label']!r}")
        check("线宽按分量算,不会因为综合权重是 0 而细得看不见",
              e["width"] > 1.0, f"实际 {e['width']}")
        check("正负分量都送到了前端(画双色用)",
              e.get("pw") == 2 and e.get("nw") == -2,
              f"实际 pw={e.get('pw')} nw={e.get('nw')}")
    db.delete_circle(mix_c)
    db.delete_person(ja)
    db.delete_person(jb)

    # ---------------- 引荐路径:跳数摩擦与方向(v6) ----------------
    print("\n引荐路径:跳数与方向")
    dir_c = db.create_circle("_方向测试", "自定义")
    ms, _ = db.upsert_person("师傅测", circle_id=dir_c)
    td, _ = db.upsert_person("徒弟测", circle_id=dir_c)
    wr, _ = db.upsert_person("外人测", circle_id=dir_c)
    db.upsert_relation(dir_c, ms, td, "提携", 2)      # 有向:a=师傅
    db.upsert_relation(dir_c, td, wr, "朋友", 2)
    fwd = analysis.intro_path(ms, wr, dir_c)
    rev = analysis.intro_path(wr, ms, dir_c)
    check("逆着「提携」的方向引荐更贵(方向以前完全没被用过)",
          rev["cost"] > fwd["cost"],
          f"顺向 {fwd['cost']} / 逆向 {rev['cost']}")

    hop_c = db.create_circle("_跳数测试", "自定义")
    hs = [db.upsert_person(f"P{i}测", circle_id=hop_c)[0] for i in range(5)]
    for i in range(3):
        db.upsert_relation(hop_c, hs[i], hs[i + 1], "朋友", 3)
    db.upsert_relation(hop_c, hs[0], hs[4], "点头之交", 1)
    long3 = analysis.intro_path(hs[0], hs[3], hop_c)
    short1 = analysis.intro_path(hs[0], hs[4], hop_c)
    check("三跳最强链比一跳最弱关系更贵(旧公式下两者都是 1.0,分不出来)",
          long3["cost"] > short1["cost"],
          f"三跳 {long3['cost']} / 一跳 {short1['cost']}")
    for c in (dir_c, hop_c):
        db.delete_circle(c)
    for pid in [ms, td, wr] + hs:
        db.delete_person(pid)

    # ---------------- AI 摄取的去重(v6 修复) ----------------
    print("\nAI 摄取:模糊匹配不该造出重复人物")
    import llm
    # 用独立圈子,别把人塞进公司圈 —— 后面的布局用例会核对「公司圈 19 人」
    sandbox = db.create_circle("_摄取测试", "自定义")
    db.upsert_person("张伟", dept="技术部", circle_id=sandbox)
    zw = db.find_person_by_name("张伟")

    before = len(db.list_people())
    # 模拟:模型把「张伟」OCR 成「张玮」,_align 标为 fuzzy,人工选了「合并」
    llm.commit({"persons": [{"name": "张玮", "dept": "", "title": "架构师",
                             "matched_id": zw["id"], "matched_name": "张伟",
                             "action": "merge", "accepted": True}],
                "relations": [], "source": ""}, sandbox)
    after = db.find_person_by_name("张伟")
    check("合并后没有多出一个人", len(db.list_people()) == before,
          f"人数 {before} → {len(db.list_people())}")
    check("库里没有叫「张玮」的独立节点",
          not any(p["name"] == "张玮" for p in db.list_people()))
    check("空的部门不会把已有的「技术部」覆盖掉",
          after["dept"] == "技术部", f"实际 {after['dept']!r}")
    check("模型给的职位补上了", after["title"] == "架构师",
          f"实际 {after['title']!r}")
    check("模型用的写法被记成别名,下次走精确匹配",
          "张玮" in (after["aliases"] or ""), f"实际 {after['aliases']!r}")
    check("用别名能查到本人",
          (db.find_person_by_name("张玮") or {}).get("id") == zw["id"])

    # 匹配器本身:该松的松,该紧的紧
    people_list = db.list_people()
    m1, how1 = llm._match_person("张玮", people_list)
    check("「张玮」能匹配到「张伟」(同姓、等长、只差一字)",
          m1 is not None and m1["name"] == "张伟",
          f"实际 {m1 and m1['name']}")
    m2, how2 = llm._match_person("李明远", people_list)
    check("「李明远」不会被误配到「李明远」以外的人",
          m2 is None or m2["name"] == "李明远",
          f"实际 {m2 and m2['name']}")

    db.delete_circle(sandbox)          # 收拾干净,后面的用例不受影响
    db.delete_person(zw["id"])

    # ---------------- v7:词表缺口与传递推导 ----------------
    print("\n词表:轻微负面(「情敌」那个错的直接根因)")
    fr = db.RELATION_KINDS.get("有摩擦")
    check("词表里有「有摩擦」", fr is not None)
    if fr:
        check("它是负向的", fr["sign"] < 0, f"实际 {fr.get('sign')}")
        check("默认强度是 -1(轻,不是 -2/-3 的重型)",
              fr["default"] == -1, f"实际 {fr.get('default')}")
        check("它是无向的", fr.get("directed") == 0)
    # 这条才是真正的守门人:在它之前,五个负向全是 -2/-3,
    # 模型读到"有点不开心"只能硬套一个重型类型
    light = [k for k, v in db.RELATION_KINDS.items()
             if v["sign"] < 0 and abs(v["default"]) == 1]
    check("至少存在一个 -1 的负向选项供模型落脚", len(light) >= 1,
          f"实际 {light}")

    print("\n事实型关系不该自带亲疏")
    FACT = ("室友", "同学", "同事", "上下级")
    signs = {k: db.RELATION_KINDS[k]["sign"] for k in FACT}
    # 「有没有这层身份」和「亲不亲近」是两回事。室友原本是 sign=+1/default=+2,
    # 导致真实案例里"被逼得退租"的两个人被显示成「室友 +2 关系不错」。
    check("事实型关系的 sign 全部一致(都是 0)",
          set(signs.values()) == {0}, f"实际 {signs}")
    check("室友默认强度是 +1(不是 +2「关系不错」)",
          db.RELATION_KINDS["室友"]["default"] == 1,
          f"实际 {db.RELATION_KINDS['室友']['default']}")
    # 用户那个例子:室友 +1 + 有摩擦 -2 应当合成负向,且触发混合边
    rmc = db.create_circle("_室友强度", "自定义")
    for nm in ("鲁娜测", "艾克斯测"):
        db.upsert_person(nm, circle_id=rmc)
    ri = {p["name"]: p["id"] for p in db.list_people(rmc)}
    db.upsert_relation(rmc, ri["鲁娜测"], ri["艾克斯测"], "室友",
                       db.RELATION_KINDS["室友"]["default"])
    db.upsert_relation(rmc, ri["鲁娜测"], ri["艾克斯测"], "有摩擦", -2)
    gm = analysis.build_graph(rmc)
    kk = (min(ri.values()), max(ri.values()))
    check("「是室友但闹得很僵」合并后是负向", gm["pair_w"][kk] < 0,
          f"实际 {gm['pair_w'][kk]}")
    check("而且触发混合边(正负分量都非零)", kk in gm["mixed"])
    db.delete_circle(rmc)
    for nm in ("鲁娜测", "艾克斯测"):
        db.delete_person(db.find_person_by_name(nm)["id"])

    print("\n出处必须能在原文里找到")
    import llm as _llm
    SRC = "Luna有个室友叫X,X很多事,鸡毛蒜皮的事情都要管,最后Luna退租了。"
    check("原样摘录能过", _llm.evidence_in_source("鸡毛蒜皮的事情都要管", SRC))
    check("只差空白/标点不算改写",
          _llm.evidence_in_source(" 鸡毛蒜皮的事情都要管 ", SRC))
    check("中英文标点差异不算改写",
          _llm.evidence_in_source("Luna有个室友叫X,X很多事", SRC))
    # 这一条来自真实事故:模型把「与luna的关系并不好」当原文摘录写进了出处,
    # 而用户输入里根本没有这句
    check("★ 编造的出处会被抓住",
          not _llm.evidence_in_source(
              "与luna的关系并不好,鸡毛蒜皮的事情都要管", SRC))
    check("整句改写会被抓住",
          not _llm.evidence_in_source("X是个很难相处的人", SRC))
    check("空出处不算通过", not _llm.evidence_in_source("", SRC))
    check("材料里有图片时一律放行(出处来自读图,本就不在文本里)",
          _llm.evidence_in_source("图上读到的话", SRC, has_images=True))

    print("\n传递推导(代码算,不交给模型)")
    rc = db.create_circle("_推导测试", "自定义")
    for nm in ("甲宿", "乙宿", "丙宿"):
        db.upsert_person(nm, circle_id=rc)
    rid = {p["name"]: p["id"] for p in db.list_people(rc)}
    db.upsert_relation(rc, rid["甲宿"], rid["乙宿"], "室友", 2)

    got = analysis.derive_transitive(
        rc, [{"a_name": "甲宿", "b_name": "丙宿", "kind": "室友"}])
    pair = {frozenset((r["a_name"], r["b_name"])) for r in got}
    check("A—C 和 B—C 都是室友 → 推出 A—B",
          frozenset(("乙宿", "丙宿")) in pair, f"实际 {[sorted(x) for x in pair]}")
    if got:
        r0 = [r for r in got if frozenset((r["a_name"], r["b_name"]))
              == frozenset(("乙宿", "丙宿"))][0]
        check("推导依据里写明了经由谁", "甲宿" in r0["derived_note"],
              r0["derived_note"])
        check("默认不勾选", r0["accepted"] is False)
        check("标了 derived", r0["derived"] is True)
        # evidence 在界面上是当"原文引用"呈现的,塞机器生成的话进去
        # 就是把推测伪装成证据 —— 整个审核流程的价值全靠这个区分
        check("**不**占用 evidence 字段", "evidence" not in r0)

    db.upsert_relation(rc, rid["乙宿"], rid["丙宿"], "室友", 2)
    check("已经存在的对不再重复提议",
          analysis.derive_transitive(
              rc, [{"a_name": "甲宿", "b_name": "丙宿", "kind": "室友"}]) == [])

    check("与本次录入无关的对不提议",
          analysis.derive_transitive(
              rc, [{"a_name": "张三", "b_name": "李四", "kind": "朋友"}]) == [])

    # 防爆炸:12 人共享一个室友,完全闭包是 66 条
    bc = db.create_circle("_大宿舍", "自定义")
    db.upsert_person("舍长测", circle_id=bc)
    hub = db.find_person_by_name("舍长测")["id"]
    for i in range(12):
        db.upsert_person(f"住户测{i}", circle_id=bc)
        db.upsert_relation(bc, hub,
                           db.find_person_by_name(f"住户测{i}")["id"], "室友", 2)
    big = analysis.derive_transitive(
        bc, [{"a_name": "住户测0", "b_name": "舍长测", "kind": "室友"}])
    check(f"上限生效:完全闭包 66 条,实际提议 {len(big)} 条",
          len(big) <= analysis.DERIVE_LIMIT)

    # 同事绝不能参与推导 —— 100 人公司同部门互推是几千条边
    cc = db.create_circle("_同事测试", "公司")
    for nm in ("同甲", "同乙", "同丙"):
        db.upsert_person(nm, dept="技术部", circle_id=cc)
    ci = {p["name"]: p["id"] for p in db.list_people(cc)}
    db.upsert_relation(cc, ci["同甲"], ci["同丙"], "同事", 1)
    db.upsert_relation(cc, ci["同乙"], ci["同丙"], "同事", 1)
    check("「同事」不参与推导(防爆炸的守门人)",
          analysis.derive_transitive(
              cc, [{"a_name": "同甲", "b_name": "同丙", "kind": "同事"}]) == [])
    check("推导名单只有室友和同学",
          set(analysis.TRANSITIVE_KINDS) == {"室友", "同学"},
          f"实际 {analysis.TRANSITIVE_KINDS}")

    for c in (rc, bc, cc):
        db.delete_circle(c)
    for nm in ["甲宿", "乙宿", "丙宿", "舍长测", "同甲", "同乙", "同丙"] + \
              [f"住户测{i}" for i in range(12)]:
        pp = db.find_person_by_name(nm)
        if pp:
            db.delete_person(pp["id"])

    # ---------------- 布局 ----------------
    print("\n布局引擎")
    for name, c in (("公司圈", company), ("同学圈", klass)):
        payload = layout.get_graph_payload(c["id"])
        n = len(payload["nodes"])
        check(f"{name}:节点数与成员数一致({n}/{c['people']})",
              n == c["people"])
        check(f"{name}:坐标都在画布内",
              all(0 <= x["x"] <= payload["width"]
                  and 0 <= x["y"] <= payload["height"] for x in payload["nodes"]))
        check(f"{name}:每条边都带弧线控制点和标签落点",
              all(all(k in e for k in ("cx", "cy", "mx", "my"))
                  for e in payload["edges"]))
        check(f"{name}:每条边都带类别标记符",
              all(e.get("glyph") for e in payload["edges"]),
              "有边缺 glyph")
        check(f"{name}:节点带首字(用于头像)",
              all(x.get("initial") for x in payload["nodes"]))

    p_company = layout.get_graph_payload(company["id"])
    p_class = layout.get_graph_payload(klass["id"])
    check("两个圈子的布局是分开缓存的,互不覆盖",
          {n["name"] for n in p_company["nodes"]} !=
          {n["name"] for n in p_class["nodes"]})
    check("同学圈的图里有情敌那条负向边",
          any(e["w"] < 0 and "情敌" in (e.get("all_kinds") or [])
              for e in p_class["edges"]))

    # 缓存键现在带画布档位 —— 不同屏幕比例各存一份,互不覆盖
    # 键里带算法版本:改了布局算法,旧缓存自动作废(否则改了没效果,
    # 而且极难查 —— 这个坑刚踩过)
    _v = layout.LAYOUT_VERSION
    cached = db.cache_get(f"graph_payload_v{_v}_{company['id']}_square")
    check("布局结果进了缓存(第二次不再重算)", cached is not None)
    check("上一个算法版本的缓存键取不到东西(改了算法就该重算)",
          db.cache_get(f"graph_payload_v{_v - 1}_{company['id']}_square") is None)
    check("不同画布档位各自缓存",
          db.cache_get(f"graph_payload_v{_v}_{company['id']}_wide") is None,
          "宽屏档位不该被方形档位的结果污染")

    # ---------------- 结果 ----------------
    print("\n" + "=" * 54)
    if FAIL:
        print(f"  失败 {len(FAIL)} 项 / 共 {len(PASS) + len(FAIL)} 项")
        for f in FAIL:
            print(f"    ✗ {f}")
        print("=" * 54)
        return 1
    print(f"  全部通过 —— {len(PASS)} 项")
    print("=" * 54)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        try:
            if db._conn:
                db._conn.close()
        except Exception:
            pass
    sys.exit(code)
