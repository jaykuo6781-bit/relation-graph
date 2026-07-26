"""AI 摄取:把一段话、一张聊天截图、或一份文档,抽成人物和关系的候选清单。

这是整个项目里唯一与模型供应商相关的文件。换供应商只需要改这里
和 config.py 的三个环境变量。

流程刻意设计成"模型出候选 → 人工逐条审核 → 才入库":小模型在中文
人物关系抽取上会漏抽、会张冠李戴,但每条候选都必须附上**原文摘录**
(evidence),用户扫一眼就能判断模型有没有编,审核环节把这个弱点兜住了。

一个显著提升小模型准确率的做法:**把当前圈子已有的人员名单一并给模型**,
让它优先匹配已有的人,而不是凭空造出重复节点。
"""

import base64
import difflib
import json

import config
import db

# 图片:直接走视觉输入。文本类:先抽成文字再送。
IMAGE_MIMES = {"image/png", "image/jpeg", "image/jpg", "image/webp",
               "image/gif", "image/heic"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".log", ".json", ".yaml", ".yml"}

MAX_TEXT_CHARS = 20000       # 单份文档送进模型的上限,避免账单失控


class LLMError(Exception):
    pass


# ============================================================
#  提示词
# ============================================================

def _system_prompt(roster):
    kinds_by_cat = {}
    for k, v in db.RELATION_KINDS.items():
        kinds_by_cat.setdefault(v["cat"], []).append(k)
    kind_lines = "\n".join(
        f"- {cat}:{'、'.join(ks)}" for cat, ks in kinds_by_cat.items())

    roster_block = ""
    if roster:
        listed = "、".join(
            f"{p['name']}({p['dept']})" if p.get("dept") else p["name"]
            for p in roster[:120])
        roster_block = (
            f"\n\n【这个圈子里已有的人】\n{listed}\n"
            "遇到这些人时,**必须使用上面列出的完全相同的姓名**,不要写成别名或简称,"
            "否则会造出重复的人。名单里没有的人才算新人。")

    return f"""你是一个人际关系信息抽取助手。用户会给你一段中文材料\
(可能是一段描述、一张聊天截图、或一份文档),里面涉及若干人之间的关系。

你的任务是抽取出:
1. 提到的人物(姓名,以及文中若有提及的部门、职位、身份)
2. 人物之间的关系

关系类型只能从以下列表中选择:
{kind_lines}

strength 取 -3 到 3 的整数:
  +3 极亲近  +2 关系不错  +1 略有交情
   0 中性
  -1 略有嫌隙  -2 有明显矛盾  -3 势不两立

严格要求:
- evidence 字段必须是材料里的**原句摘录**,不得改写、不得编造。\
如果是截图,就摘录你在图上读到的原话。找不到直接支撑的原文,就不要输出这条关系。
- confidence 是你对这条判断的把握程度,0 到 1 之间。明说的用高值,需要推测的用低值。
- 只抽取材料里真实提到的内容,不要根据常识补充推断。
- 有方向的关系(师徒、提携、上下级、单恋、好感、金钱借贷、师生):\
a 是师傅/提携者/上级/暗恋者/出借方。
- "情敌"指两人喜欢同一个对象而互相竞争,是负向关系。{roster_block}"""


def _schema():
    return {
        "type": "object",
        "properties": {
            "persons": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "name": {"type": "string", "description": "姓名"},
                        "dept": {"type": "string", "description": "部门/班级/身份,未提及则空字符串"},
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
                    "required": ["a", "b", "kind", "strength", "evidence",
                                 "confidence"],
                    "additionalProperties": False,
                },
            },
        },
        "required": ["persons", "relations"],
        "additionalProperties": False,
    }


# ============================================================
#  文件 → 文字 / 图片
# ============================================================

def _extract_text(name, mime, raw):
    """把上传的文件转成纯文本。转不了的抛 LLMError 并说清楚原因。"""
    lower = (name or "").lower()
    ext = "." + lower.rsplit(".", 1)[-1] if "." in lower else ""

    if ext in TEXT_EXTS or (mime or "").startswith("text/"):
        for enc in ("utf-8", "gbk", "utf-16", "latin-1"):
            try:
                return raw.decode(enc)
            except UnicodeDecodeError:
                continue
        raise LLMError(f"「{name}」的文字编码认不出来")

    if ext == ".pdf" or mime == "application/pdf":
        try:
            import io
            from pypdf import PdfReader
        except ImportError:
            raise LLMError(
                "读 PDF 需要额外装一个库,在电脑上执行:pip install pypdf\n"
                "(或者把内容复制成文字直接粘进来)")
        reader = PdfReader(io.BytesIO(raw))
        return "\n".join((p.extract_text() or "") for p in reader.pages)

    if ext in (".docx",) or "wordprocessingml" in (mime or ""):
        try:
            import io
            import docx
        except ImportError:
            raise LLMError(
                "读 Word 需要额外装一个库,在电脑上执行:pip install python-docx\n"
                "(或者把内容复制成文字直接粘进来)")
        d = docx.Document(io.BytesIO(raw))
        return "\n".join(p.text for p in d.paragraphs)

    if ext == ".doc":
        raise LLMError("老式的 .doc 格式读不了,请另存为 .docx 或直接粘文字")

    raise LLMError(f"不支持的文件类型:{name or mime}")


def _client():
    if not config.LLM_API_KEY:
        raise LLMError(
            "还没配置 API Key。在电脑上设置环境变量 OPENAI_API_KEY 后重启服务即可。")
    try:
        from openai import OpenAI
    except ImportError:
        raise LLMError("缺少依赖,请在电脑上执行:pip install openai")

    kwargs = {"api_key": config.LLM_API_KEY}
    if config.LLM_BASE_URL:
        kwargs["base_url"] = config.LLM_BASE_URL
    return OpenAI(**kwargs)


# ============================================================
#  主流程
# ============================================================

def ingest(text="", files=None, circle_id=None):
    """文字 / 截图 / 文档 → 待审核的候选清单。"""
    files = files or []
    text = (text or "").strip()
    if not text and not files:
        raise LLMError("请先输入点内容,或者上传一个文件")

    roster = db.list_people(circle_id)

    # 组装多模态消息
    parts = []
    doc_texts = []
    n_images = 0

    for f in files:
        name = f.get("name", "")
        mime = (f.get("mime") or "").lower()
        data = f.get("data") or ""
        if not data:
            continue
        try:
            raw = base64.b64decode(data, validate=False)
        except Exception:
            raise LLMError(f"「{name}」的内容读不出来")

        if mime in IMAGE_MIMES or mime.startswith("image/"):
            parts.append({
                "type": "image_url",
                "image_url": {"url": f"data:{mime};base64,{data}"},
            })
            n_images += 1
        else:
            extracted = _extract_text(name, mime, raw)
            if extracted.strip():
                doc_texts.append(f"【文件:{name}】\n{extracted[:MAX_TEXT_CHARS]}")

    prompt_text = text
    if doc_texts:
        prompt_text = (prompt_text + "\n\n" + "\n\n".join(doc_texts)).strip()
    if not prompt_text and n_images:
        prompt_text = "这是一张聊天截图,请从中抽取人物和他们之间的关系。"
    if not prompt_text:
        raise LLMError("没有可分析的内容")

    parts.insert(0, {"type": "text", "text": prompt_text})

    client = _client()
    try:
        resp = client.chat.completions.create(
            model=config.LLM_MODEL,
            messages=[
                {"role": "system", "content": _system_prompt(roster)},
                {"role": "user", "content": parts},
            ],
            response_format={
                "type": "json_schema",
                "json_schema": {"name": "relation_extraction",
                                "strict": True, "schema": _schema()},
            },
            temperature=0.2,
        )
    except Exception as e:
        raise LLMError(f"模型调用失败:{e}")

    content = resp.choices[0].message.content or "{}"
    try:
        raw_out = json.loads(content)
    except json.JSONDecodeError as e:
        raise LLMError(f"模型返回的不是合法 JSON:{e}")

    return _align(raw_out, prompt_text, circle_id, n_images)


def _match_person(name, people):
    """把模型给的人名对到库里已有的人。

    先精确匹配,再别名,最后用编辑距离做模糊匹配。模糊命中会单独标出来
    让用户确认,避免把"张伟"和"张玮"合成一个人。
    """
    name = (name or "").strip()
    if not name:
        return None, None
    exact = db.find_person_by_name(name)
    if exact:
        return exact, "exact"
    names = [p["name"] for p in people]
    # cutoff 从 0.75 提到 0.85,并额外要求**姓氏相同**。
    # 中文短姓名上编辑距离很不可靠:「张伟」和「张玮」只有 0.67(拦不住,
    # 而这恰恰是 OCR 最常见的错法),「李明」和「李明远」却有 0.80
    # (会被误判成同一人)。加一条"首字必须相同"能挡住后者,
    # 前者则由下面的 initial 分支补回来。
    close = difflib.get_close_matches(name, names, n=1, cutoff=0.85)
    if not close and len(name) >= 2:
        # 同姓 + 同长度 + 只差一个字 —— 典型的 OCR/听写错字
        cand = [n for n in names
                if n[0] == name[0] and len(n) == len(name)
                and sum(a != b for a, b in zip(n, name)) == 1]
        close = cand[:1]
    if close:
        for p in people:
            if p["name"] == close[0]:
                return p, "fuzzy"
    return None, None


def _align(raw, source_text, circle_id, n_images=0):
    """把模型输出跟库里已有的人对齐,生成待审核的候选表。"""
    all_people = db.list_people()          # 跨圈子匹配,避免重复建人

    person_rows = []
    for p in raw.get("persons", []):
        name = (p.get("name") or "").strip()
        if not name:
            continue
        matched, how = _match_person(name, all_people)
        person_rows.append({
            "name": name,
            "dept": p.get("dept", ""),
            "title": p.get("title", ""),
            "matched_id": matched["id"] if matched else None,
            "matched_name": matched["name"] if matched else None,
            "match_type": how,
            "action": "update" if how == "exact" else (
                "confirm" if how == "fuzzy" else "create"),
            "accepted": True,
        })

    relation_rows = []
    for r in raw.get("relations", []):
        a_name = (r.get("a") or "").strip()
        b_name = (r.get("b") or "").strip()
        kind = db.normalize_kind(r.get("kind", ""))
        if not a_name or not b_name or kind not in db.RELATION_KINDS:
            continue
        if a_name == b_name:
            continue

        pa, how_a = _match_person(a_name, all_people)
        pb, how_b = _match_person(b_name, all_people)
        info = db.RELATION_KINDS[kind]
        try:
            strength = int(r.get("strength", info["default"]))
        except (TypeError, ValueError):
            strength = info["default"]
        strength = max(-3, min(3, strength))

        relation_rows.append({
            "a_name": a_name, "b_name": b_name,
            "a_id": pa["id"] if pa else None,
            "b_id": pb["id"] if pb else None,
            "a_match": how_a, "b_match": how_b,
            "kind": kind,
            "cat": info["cat"],
            "glyph": db.CATEGORY_GLYPH.get(info["cat"], ""),
            "strength": strength,
            "evidence": r.get("evidence", ""),
            "confidence": round(float(r.get("confidence", 0) or 0), 2),
            "accepted": True,
        })

    return {
        "source": source_text[:4000],
        "images": n_images,
        "circle_id": circle_id,
        "model": config.LLM_MODEL,
        "persons": person_rows,
        "relations": relation_rows,
    }


def commit(payload, circle_id):
    """把用户审核后的结果写入指定圈子。"""
    created_people = 0
    for p in payload.get("persons", []):
        if not p.get("accepted", True) or p.get("action") == "skip":
            continue

        # _align 已经把模型给的名字对到了库里的人(matched_id),但这里以前
        # 直接拿 p["name"] 去 upsert,而 upsert_person 只按姓名**精确**匹配。
        # 后果:模型把「张伟」OCR 成「张玮」→ 关系正确挂到张伟身上,
        # 人物行却新建了一个叫「张玮」的孤立节点。整个 roster 机制就是为了
        # 避免这件事,却在最后一步被抵消掉。
        mid = p.get("matched_id")
        if mid and p.get("action") in ("update", "merge"):
            # 合并到已有的人:只补**非空**字段。
            # update_person 不像 upsert_person 那样跳过空值,直接传空串
            # 会把已有的部门职位抹掉。
            fields = {k: p.get(k, "") for k in ("dept", "title") if p.get(k)}
            if fields:
                db.update_person(mid, **fields)
            # 模型用的那个写法记成别名,下次就走精确匹配,不必再让人确认一遍
            if p.get("name") and p["name"] != p.get("matched_name"):
                db.add_alias(mid, p["name"])
            if circle_id:
                db.add_to_circle(mid, circle_id)
            continue

        _, is_new = db.upsert_person(
            p["name"], p.get("dept", ""), p.get("title", ""),
            circle_id=circle_id)
        created_people += int(is_new)

    saved = 0
    touched = set()
    for r in payload.get("relations", []):
        if not r.get("accepted", True):
            continue
        a_id, b_id = r.get("a_id"), r.get("b_id")
        if a_id is None:
            a_id, is_new = db.upsert_person(r["a_name"], circle_id=circle_id)
            created_people += int(is_new)
        if b_id is None:
            b_id, is_new = db.upsert_person(r["b_name"], circle_id=circle_id)
            created_people += int(is_new)
        if a_id == b_id:
            continue
        db.upsert_relation(circle_id, a_id, b_id, r["kind"],
                           r.get("strength"), notes=r.get("evidence", ""),
                           confidence=r.get("confidence", 1.0))
        touched.update([a_id, b_id])
        saved += 1

    # 原始材料存成一条事件,作为这些关系的证据来源
    event_id = None
    src = (payload.get("source") or "").strip()
    if src and touched:
        label = "AI 摄取"
        if payload.get("images"):
            label += f"(含 {payload['images']} 张图)"
        event_id = db.add_event(src, sorted(touched), circle_id, source=label)

    return {"people_created": created_people, "relations": saved,
            "event_id": event_id}
