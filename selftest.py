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
import sys
import tempfile
from pathlib import Path

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

    cached = db.cache_get(f"graph_payload_{company['id']}")
    check("布局结果进了缓存(第二次不再重算)", cached is not None)

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
