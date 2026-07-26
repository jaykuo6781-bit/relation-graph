"""故事解析:把一段自然语言描述抽成人物和关系的候选清单。

这是整个项目里唯一与模型供应商相关的文件。换供应商只需要改这里
和 config.py 的三个环境变量。

流程刻意设计成"模型出候选 → 人工逐条审核 → 才入库":小模型在中文
人物关系抽取上会漏抽、会张冠李戴,但每条候选都必须附上**原文摘录**
(evidence),用户扫一眼就能判断模型有没有编,审核环节把这个弱点兜住了。
"""

import difflib
import json

import config
import db

SYSTEM_PROMPT = """你是一个人际关系信息抽取助手。用户会给你一段中文描述,\
里面涉及若干同事之间的关系。

你的任务是抽取出:
1. 提到的人物(姓名,以及文中若有提及的部门、职位)
2. 人物之间的关系

关系类型只能从以下列表中选择:
- 正向:盟友、朋友、师徒、提携、同乡同学、利益共同体
- 负向:竞争、敌对、宿怨、利益冲突
- 中性:上下级、同事、认识

strength 取 -3 到 3 的整数:
  +3 关系极好  +2 关系不错  +1 略有交情
   0 中性
  -1 略有嫌隙  -2 有明显矛盾  -3 势不两立

严格要求:
- evidence 字段必须是原文中的**原句摘录**,不得改写、不得编造。\
如果找不到直接支撑的原文,就不要输出这条关系。
- confidence 是你对这条判断的把握程度,0 到 1 之间。文中明说的用高值,\
需要推测的用低值。
- 只抽取文中真实提到的内容,不要根据常识补充推断。
- 师徒、提携、上下级是有方向的:a 是师傅/提携者/上级,b 是徒弟/被提携者/下级。
"""

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "persons": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "姓名"},
                    "dept": {"type": "string", "description": "部门,未提及则空字符串"},
                    "title": {"type": "string", "description": "职位,未提及则空字符串"},
                },
                "required": ["name", "dept", "title"],
                "additionalProperties": False,
            },
        },
        "relations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "a": {"type": "string", "description": "关系一方的姓名"},
                    "b": {"type": "string", "description": "关系另一方的姓名"},
                    "kind": {"type": "string", "enum": list(db.RELATION_KINDS)},
                    "strength": {"type": "integer", "description": "-3 到 3"},
                    "evidence": {"type": "string", "description": "支撑这条判断的原文摘录"},
                    "confidence": {"type": "number", "description": "0 到 1"},
                },
                "required": ["a", "b", "kind", "strength", "evidence", "confidence"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["persons", "relations"],
    "additionalProperties": False,
}


class LLMError(Exception):
    pass


def _client():
    if not config.LLM_API_KEY:
        raise LLMError(
            "未配置 API Key。请设置环境变量 OPENAI_API_KEY 后重启服务,"
            "或在「设置」页填入。")
    try:
        from openai import OpenAI
    except ImportError:
        raise LLMError("缺少依赖,请先运行:pip install openai")

    kwargs = {"api_key": config.LLM_API_KEY}
    if config.LLM_BASE_URL:
        kwargs["base_url"] = config.LLM_BASE_URL
    return OpenAI(**kwargs)


def extract(story):
    """调模型抽取,返回原始结构化结果。"""
    story = (story or "").strip()
    if not story:
        raise LLMError("请先粘贴一段描述")

    client = _client()
    try:
        resp = client.chat.completions.create(
            model=config.LLM_MODEL,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": story},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {
                    "name": "relation_extraction",
                    "strict": True,
                    "schema": RESPONSE_SCHEMA,
                },
            },
            temperature=0.2,
        )
    except Exception as e:
        raise LLMError(f"模型调用失败:{e}")

    content = resp.choices[0].message.content or "{}"
    try:
        return json.loads(content)
    except json.JSONDecodeError as e:
        raise LLMError(f"模型返回的不是合法 JSON:{e}")


def _match_person(name, people):
    """把模型给的人名对到库里已有的人。

    先精确匹配,再别名,最后用编辑距离做模糊匹配。模糊匹配的命中会
    单独标出来让用户确认,避免把"张伟"和"张玮"合成一个人。
    """
    name = (name or "").strip()
    if not name:
        return None, None

    exact = db.find_person_by_name(name)
    if exact:
        return exact, "exact"

    names = [p["name"] for p in people]
    close = difflib.get_close_matches(name, names, n=1, cutoff=0.75)
    if close:
        for p in people:
            if p["name"] == close[0]:
                return p, "fuzzy"
    return None, None


def parse_story(story):
    """抽取 + 与现有数据对齐,生成待审核的候选表。"""
    raw = extract(story)
    people = db.list_people()

    person_rows = []
    for p in raw.get("persons", []):
        name = (p.get("name") or "").strip()
        if not name:
            continue
        matched, how = _match_person(name, people)
        person_rows.append({
            "name": name,
            "dept": p.get("dept", ""),
            "title": p.get("title", ""),
            "matched_id": matched["id"] if matched else None,
            "matched_name": matched["name"] if matched else None,
            "match_type": how,
            "action": "update" if how == "exact" else ("confirm" if how == "fuzzy" else "create"),
        })

    relation_rows = []
    for r in raw.get("relations", []):
        a_name = (r.get("a") or "").strip()
        b_name = (r.get("b") or "").strip()
        kind = r.get("kind", "")
        if not a_name or not b_name or kind not in db.RELATION_KINDS:
            continue
        if a_name == b_name:
            continue

        pa, how_a = _match_person(a_name, people)
        pb, how_b = _match_person(b_name, people)
        strength = max(-3, min(3, int(r.get("strength", 0) or 0)))

        relation_rows.append({
            "a_name": a_name, "b_name": b_name,
            "a_id": pa["id"] if pa else None,
            "b_id": pb["id"] if pb else None,
            "a_match": how_a, "b_match": how_b,
            "kind": kind,
            "strength": strength,
            "evidence": r.get("evidence", ""),
            "confidence": round(float(r.get("confidence", 0) or 0), 2),
            "accepted": True,      # 默认勾选,用户可逐条取消
        })

    return {
        "story": story,
        "model": config.LLM_MODEL,
        "persons": person_rows,
        "relations": relation_rows,
    }


def commit(payload, save_event=True):
    """把用户审核后的结果写入。"""
    created_people = 0
    for p in payload.get("persons", []):
        if not p.get("accepted", True):
            continue
        if p.get("action") == "skip":
            continue
        _, is_new = db.upsert_person(
            p["name"], p.get("dept", ""), p.get("title", ""))
        created_people += int(is_new)

    saved = 0
    touched_ids = set()
    for r in payload.get("relations", []):
        if not r.get("accepted", True):
            continue
        a_id = r.get("a_id")
        b_id = r.get("b_id")
        if a_id is None:
            a_id, is_new = db.upsert_person(r["a_name"])
            created_people += int(is_new)
        if b_id is None:
            b_id, is_new = db.upsert_person(r["b_name"])
            created_people += int(is_new)
        if a_id == b_id:
            continue

        note = r.get("evidence", "")
        db.upsert_relation(a_id, b_id, r["kind"], r.get("strength", 0),
                           notes=note, confidence=r.get("confidence", 1.0))
        touched_ids.update([a_id, b_id])
        saved += 1

    event_id = None
    if save_event and payload.get("story"):
        event_id = db.add_event(payload["story"], sorted(touched_ids))

    return {"people_created": created_people, "relations": saved,
            "event_id": event_id}
