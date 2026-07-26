"""批量导入解析器。

两种输入:
  - 人员名单:`姓名,部门,职位`,或从 Excel 直接复制过来的 TSV
  - 关系列表:`张三-李四:敌对3`,分隔符尽量宽容

两者都走"先解析出预览、用户确认后才入库"的流程。解析阶段绝不写库,
所以贴错东西不会污染数据。
"""

import re

import db

# 姓名之间的分隔符 —— 尽量宽容,不同人的书写习惯差别很大
PAIR_SEPS = ["->", "→", "-->", "<->", "—", "–", "－", "-", "与", "和", "、", "|"]
# 姓名和关系类型之间的分隔符
KIND_SEPS = [":", "：", "=", "＝"]

DEFAULT_STRENGTH = {1: 2, -1: -2, 0: 0}


def _split_first(text, seps):
    """按 seps 里最先出现的那个分隔符切成两半。"""
    best_i, best_sep = None, None
    for sep in seps:
        i = text.find(sep)
        if i >= 0 and (best_i is None or i < best_i or
                       (i == best_i and len(sep) > len(best_sep))):
            best_i, best_sep = i, sep
    if best_i is None:
        return text, None
    return text[:best_i], text[best_i + len(best_sep):]


# ---------------- 人员名单 ----------------

def parse_roster(text):
    """解析人员名单。每行一人,字段用逗号/制表符/竖线分隔。

    识别 `姓名`、`姓名,部门`、`姓名,部门,职位` 三种写法。
    """
    rows = []
    seen = set()
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in re.split(r"[\t,，|]", line) if p.strip()]
        if not parts:
            continue

        name = parts[0]
        dept = parts[1] if len(parts) > 1 else ""
        title = parts[2] if len(parts) > 2 else ""

        existing = db.find_person_by_name(name)
        if name in seen:
            status, msg = "skip", "本次粘贴里重复出现"
        elif existing:
            status, msg = "update", f"已存在(#{existing['id']}),将补充空缺字段"
        else:
            status, msg = "new", "新建"
        seen.add(name)

        rows.append({"line": lineno, "raw": line, "name": name, "dept": dept,
                     "title": title, "status": status, "message": msg})
    return rows


def commit_roster(rows):
    created = updated = 0
    for r in rows:
        if r.get("status") == "skip" or not r.get("name"):
            continue
        _, is_new = db.upsert_person(r["name"], r.get("dept", ""),
                                     r.get("title", ""))
        if is_new:
            created += 1
        else:
            updated += 1
    return {"created": created, "updated": updated}


# ---------------- 关系列表 ----------------

def parse_relations(text, auto_create=False):
    """解析关系列表。

    支持的写法:
        张三-李四:敌对3
        张三 -> 李四 : 提携 2
        张三 与 李四:朋友
        张三-李四:竞争-2

    强度可以省略,按关系类型的正负给一个默认值。
    """
    rows = []
    for lineno, raw in enumerate(text.splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue

        pair_part, kind_part = _split_first(line, KIND_SEPS)
        if kind_part is None:
            rows.append(_bad(lineno, line, "缺少 ':',无法区分人名和关系类型"))
            continue

        a_raw, b_raw = _split_first(pair_part, PAIR_SEPS)
        if b_raw is None:
            rows.append(_bad(lineno, line, "没找到两个人名的分隔符(如 - 或 ->)"))
            continue

        a_name, b_name = a_raw.strip(), b_raw.strip()
        if not a_name or not b_name:
            rows.append(_bad(lineno, line, "人名为空"))
            continue

        kind_part = kind_part.strip()
        m = re.search(r"(-?\+?\d+)\s*$", kind_part)
        strength = None
        if m:
            try:
                strength = int(m.group(1).replace("+", ""))
            except ValueError:
                strength = None
            kind_text = kind_part[:m.start()].strip()
        else:
            kind_text = kind_part

        kind = None
        for k in db.RELATION_KINDS:
            if k in kind_text:
                kind = k
                break
        if kind is None:
            rows.append(_bad(
                lineno, line,
                f"无法识别的关系类型「{kind_text}」。可用:"
                + "、".join(db.RELATION_KINDS)))
            continue

        if strength is None:
            strength = DEFAULT_STRENGTH[db.RELATION_KINDS[kind]]
        strength = max(-3, min(3, strength))

        pa = db.find_person_by_name(a_name)
        pb = db.find_person_by_name(b_name)
        missing = [n for n, p in ((a_name, pa), (b_name, pb)) if p is None]

        if missing and not auto_create:
            status = "missing"
            msg = "库里没有这个人:" + "、".join(missing) + "(可勾选自动建人)"
        elif missing:
            status, msg = "ok", "将自动新建:" + "、".join(missing)
        else:
            status, msg = "ok", ""

        rows.append({
            "line": lineno, "raw": line,
            "a_name": a_name, "b_name": b_name,
            "a_id": pa["id"] if pa else None,
            "b_id": pb["id"] if pb else None,
            "kind": kind, "strength": strength,
            "status": status, "message": msg,
        })
    return rows


def _bad(lineno, raw, message):
    return {"line": lineno, "raw": raw, "status": "error", "message": message,
            "a_name": "", "b_name": "", "kind": "", "strength": 0}


def commit_relations(rows, auto_create=False):
    saved = 0
    created_people = 0
    errors = []
    for r in rows:
        if r.get("status") == "error":
            continue
        if r.get("status") == "missing" and not auto_create:
            continue

        a_id, b_id = r.get("a_id"), r.get("b_id")
        if a_id is None:
            a_id, is_new = db.upsert_person(r["a_name"])
            created_people += int(is_new)
        if b_id is None:
            b_id, is_new = db.upsert_person(r["b_name"])
            created_people += int(is_new)

        try:
            db.upsert_relation(a_id, b_id, r["kind"], r.get("strength", 0))
            saved += 1
        except ValueError as e:
            errors.append({"line": r.get("line"), "message": str(e)})

    return {"relations": saved, "created_people": created_people,
            "errors": errors}
