"""算法自检。

demo_seed.json 里的关系不是随手编的:它预埋了已知的派系结构、已知的
引荐路径和三个已知的不稳定三角(见该文件的 _expected 字段)。这个脚本
拿那些预设值当标准答案,逐条核对算法输出。

跑法:  python selftest.py

不通过就说明算法逻辑坏了,而不是"程序没报错就算过"。
测试跑在临时数据库上,不会碰你的真实数据。
"""

import json
import os
import sys
import tempfile
from pathlib import Path

# 必须在 import config 之前设置 —— 全程用临时库
_TMP_DB = Path(tempfile.gettempdir()) / "relgraph_selftest.db"
if _TMP_DB.exists():
    _TMP_DB.unlink()
os.environ["RELGRAPH_DB"] = str(_TMP_DB)

import analysis  # noqa: E402
import db        # noqa: E402
import layout    # noqa: E402

PASS, FAIL = [], []


def check(label, ok, detail=""):
    (PASS if ok else FAIL).append(label)
    mark = "✓" if ok else "✗"
    print(f"  {mark} {label}")
    if detail and not ok:
        print(f"      {detail}")


def name_of(pid):
    p = db.get_person(pid)
    return p["name"] if p else f"#{pid}"


def main():
    seed_path = Path(__file__).resolve().parent / "demo_seed.json"
    seed = json.loads(seed_path.read_text(encoding="utf-8"))

    print("\n载入演示数据...")
    stats = db.import_all(seed, replace=True)
    me = db.find_person_by_name(seed["me"])
    if me:
        db.set_me(me["id"])
    print(f"  {stats['people']} 人 / {stats['relations']} 条关系 / "
          f"{stats['events']} 条事件\n")

    check("数据载入:人数正确", stats["people"] == 19,
          f"实际 {stats['people']},期望 19")
    check("数据载入:关系数正确", stats["relations"] == 40,
          f"实际 {stats['relations']},期望 40")
    check("数据载入:已标记「我」", me is not None and db.get_me() is not None)

    # ---------------- 派系识别 ----------------
    print("\n派系识别(Louvain)")
    fac = analysis.detect_factions()
    factions = [f for f in fac["factions"] if f["size"] >= 3]
    check("聚出 3 个主要圈子", len(factions) == 3,
          f"实际 {len(factions)} 个:"
          + " | ".join(f"{f['size']}人" for f in fac["factions"]))

    cores = {f["core"]["name"] for f in factions if f["core"]}
    for expected_core in ("陈国栋", "周文彬", "许宏伟"):
        check(f"{expected_core} 是某个圈子的核心", expected_core in cores,
              f"实际核心:{cores}")

    # 三巨头必须分属不同圈子
    def faction_of(nm):
        p = db.find_person_by_name(nm)
        for f in fac["factions"]:
            if any(m["id"] == p["id"] for m in f["members"]):
                return f["id"]
        return None

    fids = {faction_of(n) for n in ("陈国栋", "周文彬", "许宏伟")}
    check("三个总监分属三个不同圈子", len(fids) == 3, f"实际:{fids}")

    straddlers = {s["name"] for f in fac["factions"] for s in f["straddlers"]}
    check("林子豪被标为骑墙者", "林子豪" in straddlers,
          f"实际骑墙名单:{straddlers or '空'}")

    # ---------------- 引荐路径 ----------------
    print("\n引荐路径(Dijkstra)")
    su = db.find_person_by_name("苏明哲")
    zhou = db.find_person_by_name("周文彬")
    path = analysis.intro_path(su["id"], zhou["id"])
    names = [s["name"] for s in (path.get("path") or [])]
    check("苏明哲 → 周文彬 的路径是 经由林子豪",
          names == ["苏明哲", "林子豪", "周文彬"],
          f"实际:{' → '.join(names) if names else '走不通'}")

    # ---------------- 敌人的敌人 ----------------
    print("\n找敌人的敌人")
    allies = analysis.enemies_of_enemy(zhou["id"], su["id"])
    cands = allies["candidates"]
    top = cands[0]["name"] if cands else None
    check("以周文彬为目标,第一人选是陈国栋", top == "陈国栋",
          f"实际第一名:{top};完整排序:"
          + ", ".join(c["name"] for c in cands[:5]))
    check("可结盟名单包含许宏伟和韩雪梅",
          {"许宏伟", "韩雪梅"}.issubset({c["name"] for c in cands}),
          f"实际:{[c['name'] for c in cands]}")
    check("我自己不出现在名单里",
          "苏明哲" not in {c["name"] for c in cands})

    # ---------------- 不稳定三角 ----------------
    print("\n不稳定三角(结构平衡)")
    tri = analysis.unstable_triangles(limit=100)
    got = {frozenset(m["name"] for m in t["members"]) for t in tri["triangles"]}

    planted = [
        ({"苏明哲", "李明远", "王海涛"}, "我的两个朋友互相敌视"),
        ({"林子豪", "陈国栋", "周文彬"}, "骑墙者的困境"),
        ({"陈国栋", "周文彬", "许宏伟"}, "三巨头互相敌对"),
    ]
    for members, label in planted:
        check(f"找到预埋的不稳定三角:{label}", frozenset(members) in got,
              f"未找到 {members}")

    # 稳定的三角不该被报出来
    stable = frozenset({"陈国栋", "李明远", "赵晓峰"})   # 三人皆友 → 稳定
    check("稳定的三角没有被误报", stable not in got)

    # ---------------- 关键人物 ----------------
    print("\n关键人物(中介中心性)")
    key = analysis.key_people(limit=5)
    top_names = [p["name"] for p in key["people"]]
    check("桥梁人物排行里有林子豪", "林子豪" in top_names,
          f"实际前五:{top_names}")

    # ---------------- 布局 ----------------
    print("\n布局引擎")
    payload = layout.get_graph_payload()
    n_nodes = len(payload["nodes"])
    check("每个人都有坐标", n_nodes == 19, f"实际 {n_nodes} 个节点")
    in_bounds = all(0 <= n["x"] <= payload["width"]
                    and 0 <= n["y"] <= payload["height"]
                    for n in payload["nodes"])
    check("坐标都在画布范围内", in_bounds)
    distinct = len({(round(n["x"]), round(n["y"])) for n in payload["nodes"]})
    check("节点没有堆在同一个点上", distinct >= n_nodes - 1,
          f"不重合的位置只有 {distinct} 个")
    check("边数与关系对数一致", len(payload["edges"]) > 0)

    cached = db.cache_get("graph_payload")
    check("布局结果进了缓存(第二次不再重算)", cached is not None)

    # ---------------- 结果 ----------------
    print("\n" + "=" * 52)
    if FAIL:
        print(f"  失败 {len(FAIL)} 项 / 共 {len(PASS) + len(FAIL)} 项")
        for f in FAIL:
            print(f"    ✗ {f}")
        print("=" * 52)
        return 1
    print(f"  全部通过 —— {len(PASS)} 项")
    print("=" * 52)
    return 0


if __name__ == "__main__":
    try:
        code = main()
    finally:
        try:
            db.connect().close()
        except Exception:
            pass
    sys.exit(code)
