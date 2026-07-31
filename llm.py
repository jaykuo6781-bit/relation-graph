"""AI 摄取:把一段话、一张聊天截图、或一份文档,抽成人物和关系的候选清单。

这是整个项目里唯一与模型供应商相关的文件。换供应商只需要改这里
和 config.py 的三个环境变量。

流程刻意设计成"模型出候选 → 人工逐条审核 → 才入库":小模型在中文
人物关系抽取上会漏抽、会张冠李戴,但每条候选都必须附上**原文摘录**
(evidence),用户扫一眼就能判断模型有没有编,审核环节把这个弱点兜住了。

一个显著提升小模型准确率的做法:**把当前圈子已有的人员名单一并给模型**,
让它优先匹配已有的人,而不是凭空造出重复节点。

默认还会把当前圈子**已记录的关系网**一并发给模型(_relations_block)——
「我所有朋友都认识她」这类群体说法的名单只存在于关系网里,不发的话模型
只能瞎猜或丢弃。这意味着关系数据会外发给模型服务商;
在 .env 里设 RELGRAPH_LLM_SEND_RELATIONS=0 可关闭(群体说法将只出提示)。
"""

import base64
import difflib
import json

import analysis
import config
import db

# 图片:直接走视觉输入。文本类:先抽成文字再送。
IMAGE_MIMES = {"image/png", "image/jpeg", "image/jpg", "image/webp",
               "image/gif", "image/heic"}
TEXT_EXTS = {".txt", ".md", ".markdown", ".csv", ".log", ".json", ".yaml", ".yml"}

MAX_TEXT_CHARS = 20000       # 单份文档送进模型的上限,避免账单失控

# 「我的朋友」的定义 —— 与前端 bulkQuick 的 AFFECT 集合一致:
# 只看这几种亲近关系的 kind,不看强度(同事 +1 也是正的,但"我所有朋友"
# 显然不该把只是同事的人算进去)。群体展开的名单按它圈。
AFFECT_KINDS = ("朋友", "死党", "情侣", "暧昧", "好感", "派系盟友")

# 群体说法的保守探测模式:(探测子串, 词干)。子串在归一化后的原文里出现、
# 而模型既没标 group_claim 也没有展开行/notice 时,兜底提示用户 ——
# 「不静默丢弃」的保证不能依赖模型配合(v10 就是栽在这:模型两头全空,
# 系统毫无察觉)。词干用于判断「模型已处理」:claim 短语/展开行/notice
# 里含同一词干就不再提示。
# **宁漏勿滥**:误报会让每次录入都弹提示,用户很快学会无视 warnbox,
# 真警报也跟着失效。所以不收「大家都」「朋友们」这类裸词(「大家都很开心」
# 是日常叙述);往这张表加条目前,先想清楚哪句正常的话会误命中。
GROUP_HINT_PATTERNS = (
    ("所有朋友", "朋友"), ("所有的朋友", "朋友"), ("全部朋友", "朋友"),
    ("朋友们都", "朋友"), ("朋友都认识", "朋友"),
    ("室友都", "室友"), ("同学都认识", "同学"), ("同事都认识", "同事"),
    ("大家都认识", "大家"), ("大家都熟", "大家"),
    ("部门的人都", "部门"), ("我们部门都", "部门"),
    ("班的人都", "班"), ("组的人都", "组"), ("宿舍的人都", "宿舍"),
)


def _pseudo_group_name(name):
    """「Alex的室友」这类被模型当成**人名**输出的群体短语。

    真机抓到过:模型在 relations 里给出 b=「Alex的室友」,确认入库会真的
    建出一个叫这个的节点。是群体短语 → 返回剥好尾巴的短语(交给 claim
    解析器展开),不是 → None。
    """
    npz = _norm_quote(name)
    for suf in ("都认识", "都熟", "都见过", "都", "们"):
        if npz.endswith(suf):
            npz = npz[: -len(suf)]
    for kw in ("的室友", "的同学", "的朋友"):
        if npz.endswith(kw) and len(npz) > len(kw):
            return npz
    return None


def _unhandled_group_hints(norm_src, claims, relation_rows, notices):
    """确定性兜底:原文像群体说法、但模型两头都空着的模式。返回命中子串。

    纯函数,selftest 直接打桩测。handled 集合把模型 claim 的 phrase、
    已生成的展开行、模型自己写的 notices 拼起来归一化 —— 模型写的短语
    (「我的朋友们」)和探测子串(「朋友们都」)对不上没关系,词干对上就算已处理。
    ⚠ 刻意**不算** claim 的 evidence:它常常引用整句话,一句里有两个群体
    说法时(「我和X的室友都认识,她认识我所有朋友」),只处理了朋友那个、
    evidence 却带着「室友都」—— 把 evidence 算进来,室友那个漏网就被掩盖了
    (真机抓到过)。
    """
    handled = _norm_quote("".join(
        [(c.get("phrase") or "")
         for c in claims if isinstance(c, dict)]
        + [r.get("expanded_from") or "" for r in relation_rows]
        + [n for n in notices if isinstance(n, str)]))
    hits, seen = [], set()
    for pat, stem in GROUP_HINT_PATTERNS:
        if pat in norm_src and stem not in seen and stem not in handled:
            seen.add(stem)
            hits.append(pat)
    return hits[:2]


class LLMError(Exception):
    pass


# ============================================================
#  提示词
# ============================================================

def _relations_block(circle_id, cap=400):
    """把当前圈子已记录的关系压缩成给模型看的文本块。

    这是「群体说法展开」的原料:「我所有朋友都认识 Joan」里的"所有朋友"
    到底指谁,只有这张关系网知道 —— 不发的话模型只能瞎猜或者丢弃。
    cap 做成参数是为了 selftest 用小值测截断,不必真造几百条。
    """
    me = db.get_me()
    people = db.list_people(circle_id)
    me_in = bool(me) and any(p["id"] == me["id"] for p in people)
    if me_in:
        head = (f"「我」就是名单里的「{me['name']}」。"
                "材料里出现「我」时,请一律写这个真名,不要输出叫「我」的人。")
    else:
        head = ("用户还没标记「我」是谁 ——「我的朋友」这类说法没法确定名单,"
                "写进 notices 提醒用户,不要硬展开。")

    by_id = {p["id"]: p["name"] for p in people}
    undirected = {}          # (lo,hi) -> ["朋友+2", "竞争-1", ...]
    directed_lines = []
    n = 0
    for r in db.list_relations(circle_id):
        a, b = by_id.get(r["a_id"]), by_id.get(r["b_id"])
        if not a or not b:
            continue
        n += 1
        s = r["strength"]
        tag = f"{r['kind']}{'+' if s > 0 else ''}{s}"
        if r["directed"]:
            directed_lines.append(f"{a}→{b}:{tag}")
        else:
            undirected.setdefault((min(a, b), max(a, b)), []).append(tag)

    lines = [f"{a}—{b}:{'、'.join(tags)}"
             for (a, b), tags in sorted(undirected.items())]
    lines += sorted(directed_lines)
    cut = ""
    if len(lines) > cap:
        lines = lines[:cap]
        cut = f"\n(关系太多,只列出了前 {cap} 条)"
    body = "\n".join(lines) if lines else "(这个圈子还没记录任何关系)"
    return f"{head}\n{body}{cut}"


def _system_prompt(roster, relations_block=None):
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

    # 群体说法:「我所有朋友」「我们部门的人」「大家都认识X」。
    # relations_block 给了(默认开)→ 指导模型按关系网展开;
    # 没给(RELGRAPH_LLM_SEND_RELATIONS=0)→ 明令不要展开,写进 notices。
    if relations_block is not None:
        group_block = """

【群体说法】(必须执行)
材料里出现「我所有朋友」「我们部门的人」「大家都认识X」这类指向**一群人**的说法时,
把它记进 group_claims —— **具体名单由程序按关系网确定,你不用也不要列名单**:
- phrase:群体短语的原文(如「我认识的所有朋友」);「Alex 的室友们」这类
  **别人的群体**也算,phrase 必须带上那个人的名字(如「Alex的室友」)。
- group:三选一。「我的朋友」= 短语说的是我的朋友/好友/兄弟们这类亲近的人;
  「我们部门」= 短语按部门/班级圈人(我们组、我们班都算);其余选「其他」。
- target:群体说法指向的那个人的姓名(「大家都认识X」「X认识我所有朋友」
  里的 X)。target 是代词(她/他)时,先还原成前文说的那个人,写真名。
- 方向不影响识别:「她认识我所有朋友」和「我所有朋友都认识她」是同一件事,
  都要记进 group_claims,target 都是「她」指的那个人。
- kind / strength:这群人与 target 是什么关系 —— 泛泛的「认识」「都认识」
  「都见过」「共有」用「点头之交」强度 0,除非材料明说是朋友。
- evidence:材料里说这句话的那个原句。
例:「我和 Alex 的室友都认识」→ {phrase:「Alex的室友」, group:「其他」,
target:「我」的真名, kind:「点头之交」}。
「X也是我的朋友」这句话本身就是一条关系(我—X:朋友),必须照常在
relations 里输出,别因为它挨着群体说法就漏掉。
一条 evidence 只支撑它**明说的那两个人**:「Joan也是我的朋友」只支撑
Joan—我,不支撑 Joan 和别人。「X的室友」不是人名,绝不能出现在 relations
的 a/b 里 —— 那是群体短语,只能进 group_claims。
两条边界(容易搞错,请逐字执行):
- 只有**点名一群人**的说法(我所有朋友、我们部门的人、大家)才进 group_claims;
  「她和某乙比较亲近」这种**两个人之间**的关系,**绝不进 group_claims**,
  照常写进 relations —— 它一进 group_claims 就丢了。句子用代词(她/他)指代
  前文某个人时,先把代词还原成那个人,它仍是两个人之间的关系。
  「亲近」「走得近」「关系好」说的是**朋友**(强度 +2 上下),不是点头之交。
- group_claims 是额外的补充,不能取代普通抽取:同一段材料里,群体说法记进
  group_claims,**其余明说的关系照常在 relations 里逐条输出,一条都不能少**。
例:「某丁是我所有朋友都认识的,她和某乙走得近」→ 两个输出**都要**:
group_claims 记 {phrase:「我所有朋友」, group:「我的朋友」, target:「某丁」,
kind:「点头之交」};relations 里照常输出 某丁—某乙:朋友。

relations 里的 expanded_from 一律填空字符串(展开由程序完成);
没有群体说法就给空的 group_claims;没有要说明的事,notices 给空数组。"""
        rel_text = f"\n\n【这个圈子里已记录的关系】\n{relations_block}"
    else:
        group_block = """

【群体说法】
材料里出现「我所有朋友」「我们部门的人」这类指向一群人的说法时,**不要**展开成
具体的人 —— 你看不到已记录的关系,展开只能靠编。把这句话的意思用一句人话写进
notices 提醒用户手动处理。group_claims 给空数组,expanded_from 一律填空字符串。"""
        rel_text = ""

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

关于 strength,先分清两类关系:

**事实型**(室友、同学、同事、上下级、亲戚、前任、金钱借贷):
它们描述"有没有这层身份"。**这类关系的 strength 只能取 0 到 +3,永远不能是负数**
—— "是室友""是同事"这件事本身不是坏事,关系差是**另一回事**,要另开一条。
材料没提亲疏就用通常值(多为 +1);材料表明两人因为这层身份而**亲近**才往上调。
材料表明关系差时,**事实这条不动**,把负面写进下面的情感型关系里。

**情感型**(朋友、死党、有摩擦、敌对、情侣、竞争……):
strength 就是这份情感本身的强度,按前面那张对照表给。

两条都要遵守:

1. **负面只写在负面那条上。** 一对人同时有身份关系和负面关系时
(比如"是室友但闹得很僵"),**分别输出两条**:
   室友 +1(身份,不动) + 有摩擦 -2(负面,按严重程度)
   **错误示范**:室友 -2(把负面折算进了身份那条)、
   或者 室友 0 + 有摩擦 -2(同样是在身份那条上做减法)。
   这样写会让"两人是室友但处不来"被抹平成"两人关系差",
   而前者才是真相 —— 他们确实住在一起过,这个事实不该因为闹翻就消失。
2. **负面的严重程度要看结果,不要一律给 -1。**「退租了」「绝交」「闹翻了」
「从此再没联系」「当众吵起来」这类**结果性描述**是强信号,应该给 -2 甚至 -3。
只有"有点不开心""嘀咕了几句"这种才是 -1。

严格要求:
- evidence 字段必须是材料里的**原句摘录**,不得改写、不得编造。\
如果是截图,就摘录你在图上读到的原话。找不到直接支撑的原文,就不要输出这条关系。\
(群体说法展开出的关系,evidence 就填那句群体说法的原句 —— 它就是原文。)
- confidence 是你对这条判断的把握程度,0 到 1 之间。明说的用高值,需要推测的用低值。
- 只抽取材料里真实提到的内容,不要根据常识补充推断。\
**唯一的例外是【群体说法】的展开(见下)—— 那不是推断,是查表,必须做。**
- 有方向的关系(师徒、提携、上下级、单恋、好感、金钱借贷、师生):\
a 是师傅/提携者/上级/暗恋者/出借方。

关于负面关系(这里最容易出错,请逐条照做):
- 读得出有负面情绪、但**说不清具体是哪一种矛盾**时,一律用"有摩擦",\
并给一个低 confidence。不要为了从列表里选一个而硬套具体类型 —— \
"有点不开心""闹了别扭""有意见""抱怨了几句"全都属于这一类。
- "情敌"**只在材料明确提到两人争夺同一个感情对象时**才能用。\
仅仅是不高兴、有矛盾、关系紧张,都不是情敌。
- "敌对""宿怨"是 -3 的重型关系,只在材料明确表现出长期、强烈的对立时才用。
- "竞争""利益冲突"要材料里真的提到了竞争或利益上的冲突,\
不能因为两人都在同一个部门就推断。
- 拿不准的宁可不输出这条关系。少抽一条用户可以自己补,\
抽错一条会污染整张关系图,而且用户往往发现不了 —— 它看起来像一条正常的关系。\
{group_block}{roster_block}{rel_text}"""


def _group_claims_schema():
    """group_claims 数组的 schema。主抽取和专注重试(_retry_group_claims)
    共用同一份 —— 两处各写一份迟早分叉。"""
    return {
        "type": "array",
        "items": {
            "type": "object",
            "properties": {
                "phrase": {"type": "string",
                           "description": "群体短语的原文"},
                "group": {"type": "string",
                          "enum": ["我的朋友", "我们部门", "其他"]},
                "target": {"type": "string",
                           "description": "群体说法指向的那个人的姓名"},
                "kind": {"type": "string",
                         "enum": list(db.RELATION_KINDS)},
                "strength": {"type": "integer",
                             "description": "-3 到 3"},
                "evidence": {"type": "string",
                             "description": "材料里说这句话的原句"},
                "confidence": {"type": "number",
                               "description": "0 到 1"},
            },
            "required": ["phrase", "group", "target", "kind",
                         "strength", "evidence", "confidence"],
            "additionalProperties": False,
        },
    }


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
                        # strict 模式没有"可选字段",空串是既有的哨兵写法(见 dept/title)
                        "expanded_from": {
                            "type": "string",
                            "description": "从哪个群体短语(如「我所有朋友」)展开而来,"
                                           "普通关系填空字符串"},
                    },
                    "required": ["a", "b", "kind", "strength", "evidence",
                                 "confidence", "expanded_from"],
                    "additionalProperties": False,
                },
            },
            # 群体说法只**标记**,不展开 —— 名单枚举是查表活,实测小模型
            # 做不可靠(会漏人、会把"我的朋友"当成"我"),交给代码做
            "group_claims": _group_claims_schema(),
            "notices": {
                "type": "array",
                "items": {"type": "string"},
                "description": "仅用于「群体说法无法展开」之类必须告诉用户的说明,"
                               "没有就给空数组",
            },
        },
        "required": ["persons", "relations", "group_claims", "notices"],
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

    # 不传 timeout 的话,断网/被墙时请求会挂到底层 TCP 放弃为止(可能几分钟),
    # 前端的 busy 遮罩全程转圈没有出口 —— 超时兜底必须在这里给
    kwargs = {"api_key": config.LLM_API_KEY, "timeout": config.LLM_TIMEOUT}
    if config.LLM_BASE_URL:
        kwargs["base_url"] = config.LLM_BASE_URL
    return OpenAI(**kwargs)


def _retry_group_claims(source_text, hints, circle_id):
    """专注重试:只让模型做「标记群体说法」这一件事。

    主抽取是多任务(人物+关系+群体+出处),4o-mini 负载一高就漏标群体
    (真机 0/3 抓到过)。确定性检测(GROUP_HINT_PATTERNS)发现漏网时,
    发起这次单任务小调用 —— 单任务提示的服从率高得多。
    失败(断网/没配 Key)由调用方吞掉,落回确定性提示兜底。
    """
    me = db.get_me()
    roster = db.list_people(circle_id)
    names = "、".join(p["name"] for p in roster[:120])
    me_line = f"「我」就是「{me['name']}」,涉及「我」时写这个真名。" if me else ""
    sys_p = f"""材料里疑似有这些指向一群人的说法:「{'」「'.join(hints)}」。
你只做一件事:把材料里**指向一群人**的说法逐条记进 group_claims:
- phrase:群体短语的原文;「Alex 的室友们」这类别人的群体,phrase 要带上
  那个人的名字(如「Alex的室友」)。
- group:「我的朋友」(我的朋友/好友/兄弟们)/「我们部门」(按部门/班级)/
  「其他」三选一。
- target:这群人认识/接触的那个人的**真名**。代词(她/他)要还原:
  「Joan也是我的朋友并且她认识…」里的「她」指 Joan(刚被介绍的那个人),
  **不是**句子后面挨着的名字;「我和X的室友都认识」的 target 是「我」的真名。
- kind:泛泛的「认识」「都认识」「共有」用「点头之交」,strength 0。
- evidence:材料里说这句话的那个原句。
{me_line}这个圈子里已有的人:{names}。
具体名单由程序确定,你不用列。没法确定的写进 notices;没有就给空数组。"""

    schema = {
        "type": "object",
        "properties": {
            "group_claims": _group_claims_schema(),
            "notices": {"type": "array", "items": {"type": "string"}},
        },
        "required": ["group_claims", "notices"],
        "additionalProperties": False,
    }
    client = _client()
    resp = client.chat.completions.create(
        model=config.LLM_MODEL,
        messages=[
            {"role": "system", "content": sys_p},
            {"role": "user", "content": source_text[:4000]},
        ],
        response_format={
            "type": "json_schema",
            "json_schema": {"name": "group_claims_only",
                            "strict": True, "schema": schema},
        },
        temperature=0,
    )
    return json.loads(resp.choices[0].message.content or "{}")


def _human_llm_error(e):
    """把 SDK 抛出来的英文异常翻成能指导下一步动作的中文。

    刻意不 import openai 的异常类做 isinstance —— openai 是可选依赖,
    这个模块必须在没装它的机器上也能 import。按类名字符串和文案匹配就够了:
    SDK 换版本、换供应商,最坏也只是落到兜底那条,不会崩。
    """
    name = type(e).__name__
    text = str(e).lower()

    # base_url 指到本机/内网时,"配代理"是错误指引(Ollama 没起来才是常因);
    # 照做还可能把本地请求也导进代理,越修越坏。只看主机名,不在全串里
    # 找子串 —— "10." 这种裸子串会误伤域名/端口。
    host = ""
    base = (config.LLM_BASE_URL or "").lower()
    if "//" in base:
        host = base.split("//", 1)[1].split("/", 1)[0].split(":", 1)[0]
    local = (host in ("127.0.0.1", "localhost", "0.0.0.0")
             or host.startswith("192.168.") or host.startswith("10."))
    net_hint = (
        f"当前 OPENAI_BASE_URL 指向本机/内网({config.LLM_BASE_URL}),"
        "先确认那个模型服务(比如 Ollama)真的在运行。"
        if local else
        "如果你在国内网络,大概率是没配代理 —— 打开项目目录的 .env,"
        "按 env.example 里「国内网络必看」那段配置 HTTPS_PROXY 后重启服务。")

    if "Timeout" in name or "timed out" in text or "timeout" in text:
        return "模型请求超时。" + net_hint
    if "Connection" in name or "connection" in text:
        return "连不上模型服务。" + net_hint
    # 状态码只认锚定写法(openai SDK 的文案是 "Error code: 401 - ..."),
    # 绝不在全文里找裸数字子串:"14293 tokens" 含 "429"、请求 id 里
    # 也可能带 "401",裸匹配会把上下文超限/服务端故障误判成限流/坏 Key,
    # 用户被引去查余额,真实原因反而看不到
    if "Authentication" in name or "error code: 401" in text:
        return "API Key 不对或已失效,请检查 .env 里的 OPENAI_API_KEY。"
    if "RateLimit" in name or "error code: 429" in text:
        return "模型服务限流或余额不足,稍等再试或检查账户余额。"
    return f"模型调用失败:{e}"


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
                {"role": "system", "content": _system_prompt(
                    roster,
                    _relations_block(circle_id)
                    if config.LLM_SEND_RELATIONS else None)},
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
        raise LLMError(_human_llm_error(e))

    content = resp.choices[0].message.content or "{}"
    try:
        raw_out = json.loads(content)
    except json.JSONDecodeError as e:
        raise LLMError(f"模型返回的不是合法 JSON:{e}")

    return _align(raw_out, prompt_text, circle_id, n_images)


# 中英标点/全半角的对照。模型摘录时常常把「,」写成「,」或者顺手加个空格,
# 那不算改写 —— 只按原样比对会大面积误报,反而让这个检查失去意义。
_PUNCT = str.maketrans({
    "，": ",", "。": ".", "、": ",", "；": ";", "：": ":",
    "？": "?", "！": "!", "（": "(", "）": ")",
    "「": '"', "」": '"', "“": '"', "”": '"', "‘": "'", "’": "'",
    "—": "-", "－": "-", "～": "~", "　": " ",
})


def _norm_quote(t):
    """归一化到可比对的形态:去掉全部空白、统一标点、转小写。"""
    t = (t or "").translate(_PUNCT).lower()
    return "".join(t.split())


def evidence_in_source(evidence, source, has_images=False):
    """出处是不是真的来自原文。

    **这是整个审核流程的地基。** 用户判断该不该勾一条关系,靠的就是扫一眼
    出处 —— "原文确实这么写的,那这条可信"。真实案例:用户输入里根本没有
    「与luna的关系并不好」这句,模型却把它当原文摘录写进了出处。
    这种编造比编造关系本身更难发现:关系错了还能凭常识察觉,
    出处错了用户只会以为原文就是那样。

    提示词里早就写着"必须是原句摘录",但**没有任何东西在校验它**。
    这里用确定性的字符串包含来查,不需要模型配合,也就骗不过去。

    材料里有图片时一律放行 —— 那时出处来自模型读图,本来就不在文本里。
    """
    if has_images:
        return True
    e = _norm_quote(evidence)
    if not e:
        return False
    return e in _norm_quote(source)


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
        # 伪人名过滤:「我」「她」和「Alex的室友」都不是可以建档的人 ——
        # 放进去会在人物段生成一个真的会入库的伪节点
        if _norm_quote(name) in ("我", "她", "他", "我自己"):
            continue
        if _pseudo_group_name(name):
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

    # 本圈已有的 (a,b,kind) → strength,给每条候选标「会不会覆盖已有关系」。
    # upsert 的键就是这三元组,同 kind 直接 UPDATE —— 群体展开一次几十条,
    # 不标出来的话会悄悄覆盖用户手工调过的强度。
    existing = {}
    for er in db.list_relations(circle_id):
        existing[(er["a_id"], er["b_id"], er["kind"])] = er["strength"]

    # 「我」的信息在行级清洗就要用(端点名「我」要还原成真名),提前取
    me = db.get_me()
    circle_people = db.list_people(circle_id)
    me_in = bool(me) and any(p["id"] == me["id"] for p in circle_people)

    norm_src = _norm_quote(source_text)
    relation_rows = []
    pre_claims = []     # 模型把「X的室友」当人名输出时,整行转成 claim 从这走
    seen_pairs = set()      # 同一批里的镜像重复(a、b 调换再来一遍)只留第一条
    for r in raw.get("relations", []):
        a_name = (r.get("a") or "").strip()
        b_name = (r.get("b") or "").strip()
        kind = db.normalize_kind(r.get("kind", ""))
        if not a_name or not b_name or kind not in db.RELATION_KINDS:
            continue
        info = db.RELATION_KINDS[kind]
        try:
            strength = int(r.get("strength", info["default"]))
        except (TypeError, ValueError):
            strength = info["default"]
        strength = max(-3, min(3, strength))

        # ---- 伪人名清洗(真机抓到过:确认入库会建出叫「我」和「Alex的室友」
        # 的节点)----
        # ① 端点名是「我」→ 还原成真名;没标「我」就只能丢这行
        if _norm_quote(a_name) in ("我", "我自己"):
            if not me_in:
                continue
            a_name = me["name"]
        if _norm_quote(b_name) in ("我", "我自己"):
            if not me_in:
                continue
            b_name = me["name"]
        # ② 端点名是「X的室友」这类群体短语 → 它不是人,是没被标成 claim 的
        # 群体说法:整行转成 claim,交给同一套确定性解析器展开
        ga = _pseudo_group_name(a_name)
        gb = _pseudo_group_name(b_name)
        if ga and gb:
            continue
        if ga or gb:
            pre_claims.append({
                "phrase": ga or gb,
                "group": "其他",
                "target": b_name if ga else a_name,
                "kind": kind, "strength": strength,
                "evidence": r.get("evidence", ""),
                "confidence": r.get("confidence", 0.7),
            })
            continue
        if a_name == b_name:
            continue
        # 无向关系按名字归一去重;有向的方向本身有语义,原样为键。
        # 小模型做群体展开时爱把 (Joan,小美) 和 (小美,Joan) 各输出一遍 ——
        # 不拦的话审核界面会出现两条一模一样的候选,勾了还会重复 upsert
        pair_key = (kind, a_name, b_name) if kind in db.DIRECTED_KINDS \
            else (kind,) + tuple(sorted((a_name, b_name)))
        if pair_key in seen_pairs:
            continue
        seen_pairs.add(pair_key)

        pa, how_a = _match_person(a_name, all_people)
        pb, how_b = _match_person(b_name, all_people)

        expanded_from = (r.get("expanded_from") or "").strip()
        row = {
            "a_name": a_name, "b_name": b_name,
            "a_id": pa["id"] if pa else None,
            "b_id": pb["id"] if pb else None,
            "a_match": how_a, "b_match": how_b,
            "kind": kind,
            "cat": info["cat"],
            "glyph": db.CATEGORY_GLYPH.get(info["cat"], ""),
            "strength": strength,
            "evidence": r.get("evidence", ""),
            # 出处必须真的来自原文 —— 见 evidence_in_source 的说明。
            # 对不上的在审核界面会被标出来并默认不勾。
            "evidence_ok": evidence_in_source(
                r.get("evidence", ""), source_text, n_images > 0),
            "confidence": round(float(r.get("confidence", 0) or 0), 2),
            "accepted": True,
            "expanded_from": expanded_from,
        }

        if expanded_from:
            # 幽灵判定:展开出的名字既不在库里、原文里也找不到 → 大概率是编的。
            # ⚠ 只看"没 matched"不行 —— 「Joan是我所有朋友里的共有」里的 Joan
            # 正是本次材料新引入的人:库里没有,但原文里明明白白写着,不算幽灵。
            # 有图片时跳过(名字来自读图,与 evidence 的放行逻辑一致)。
            def _unknown(nm, pid):
                return pid is None and _norm_quote(nm) not in norm_src
            ghost = n_images == 0 and (
                _unknown(a_name, row["a_id"]) or _unknown(b_name, row["b_id"]))
            if ghost:
                row["expand_ghost"] = True
                row["accepted"] = False

        # 覆盖预警:两端都对上了库里的人时,查这一对同 kind 是否已存在。
        # 键要过 normalize_pair —— 无向对按 a<b 归一,有向的方向敏感,
        # 不归一会漏报/误报。derived 行没有 id,天然不标。
        if row["a_id"] and row["b_id"]:
            na, nb, _d = db.normalize_pair(row["a_id"], row["b_id"], kind)
            if (na, nb, kind) in existing:
                row["existing_strength"] = existing[(na, nb, kind)]

        # 证据错配守卫(窄模式):出处说「…是我的朋友/死党」,行的两端却都
        # 不是「我」—— 真机抓到过 Joan—Alex 挂着「Joan也是我的朋友」的出处,
        # substring 校验挡不住这种张冠李戴。默认不勾,理由上屏。
        if me_in and not expanded_from:
            ne = _norm_quote(r.get("evidence", ""))
            if ("是我的朋友" in ne or "是我的死党" in ne):
                nm_me = _norm_quote(me["name"])
                if _norm_quote(a_name) != nm_me and _norm_quote(b_name) != nm_me:
                    row["evidence_mismatch"] = True
                    row["accepted"] = False

        relation_rows.append(row)

    # ---- 群体说法展开:模型标记(group_claims),代码枚举名单 ----
    #
    # 分工是实测出来的:gpt-4o-mini 能可靠地识别"这句话说的是一群人"、
    # 指认对象、选关系类型,但**照关系网枚举名单做不可靠** —— 三轮提示词
    # 加强后仍会漏掉死党、把"我的朋友"当成"我"、同一对正反输出两遍。
    # 枚举是查表活,代码做:一个不漏、绝不圈错、天然去重。
    extra_notices = []
    # me / circle_people / me_in 已在行级清洗前取好(见上)
    name_of = {p["id"]: p["name"] for p in circle_people}

    # 展开去噪的依据(真机用户抓到过"朋友+2 与 点头之交 0 并存"的自相矛盾):
    # batch_pairs = 本批**直接说的**关系对(任意 kind,名字归一化);
    # db_pairs    = 库里已有任意关系的对(按 id)。
    batch_pairs = {
        frozenset((_norm_quote(r["a_name"]), _norm_quote(r["b_name"])))
        for r in relation_rows if not r.get("expanded_from")}
    db_pairs = {frozenset((a, b)) for (a, b, _k) in existing}

    # claims 的处理包成闭包:主抽取标的和专注重试补标的走**同一段代码**。
    # handled_claims 记录处理过的全部 claim,供补行与兜底检测使用。
    handled_claims = []

    def _process_claims(claim_list):
        for gcm in claim_list:
            if not isinstance(gcm, dict):
                continue
            handled_claims.append(gcm)
            phrase = (gcm.get("phrase") or "").strip()
            target_name = (gcm.get("target") or "").strip()
            gtype = (gcm.get("group") or "其他").strip()
            kind = db.normalize_kind(gcm.get("kind") or "点头之交")
            if kind not in db.RELATION_KINDS:
                kind = "点头之交"
            info = db.RELATION_KINDS[kind]
            try:
                strength = max(-3, min(3, int(gcm.get("strength", info["default"]))))
            except (TypeError, ValueError):
                strength = info["default"]
            evidence = gcm.get("evidence", "")
            try:
                conf = round(float(gcm.get("confidence", 0) or 0), 2)
            except (TypeError, ValueError):
                conf = 0.0
            if not phrase or not target_name:
                continue
            if not me_in:
                extra_notices.append(
                    f"材料里的「{phrase}」指一群人,但还没在这个圈子里标记"
                    f"「我」是谁,没法确定名单 —— 去设置页指定后重发,"
                    f"或用人物卡的「批量」手工勾选。")
                continue

            # 名单:确定性地从库里圈
            if gtype == "我的朋友":
                members = set()
                for er in db.list_relations(circle_id):
                    if er["kind"] not in AFFECT_KINDS:
                        continue
                    if er["a_id"] == me["id"]:
                        members.add(er["b_id"])
                    elif er["b_id"] == me["id"]:
                        members.add(er["a_id"])
            elif gtype == "我们部门":
                dept = (me.get("dept") or "").strip()
                if not dept:
                    extra_notices.append(
                        f"「{phrase}」按部门圈人,但「我」({me['name']})"
                        f"还没填部门,没法确定名单。")
                    continue
                members = {p["id"] for p in circle_people
                           if (p.get("dept") or "").strip() == dept
                           and p["id"] != me["id"]}
            else:
                # 「某人的室友/同学/朋友」:phrase 恰好是「<圈内唯一人名>的室友」
                # 这类形态时,确定性解析出 anchor,照查表展开。
                # 保守闸:前缀匹配不到唯一的人(「我和alex的室友」的前缀是
                # "我和alex")→ 不硬展开 —— 这句连人读着都有歧义。
                members = None
                npz = _norm_quote(phrase)
                # 模型给的 phrase 常带尾巴(「Alex的室友都认识」「…的室友们」),
                # 剥掉这些不影响语义的后缀再匹配 —— 歧义闸(前缀必须是唯一人名)
                # 不因此放松
                for suf in ("都认识", "都熟", "都见过", "都", "们"):
                    if npz.endswith(suf):
                        npz = npz[: -len(suf)]
                force_me_target = False
                for kw, kinds in (("室友", ("室友",)), ("同学", ("同学",)),
                                  ("朋友", AFFECT_KINDS)):
                    if not npz.endswith("的" + kw):
                        continue
                    owner = npz[: -len(kw) - 1]
                    # 「我和X的室友都认识」= X 的室友们都认识**我**(用户点名过
                    # 这个语义)。剥掉「我和/我跟」,anchor 取 X,target 强制改成
                    # 「我」—— 这个形态下模型填的 target 不可信,经常是句子里
                    # 别的人。
                    for pre in ("我和", "我跟"):
                        if owner.startswith(pre) and len(owner) > len(pre):
                            owner = owner[len(pre):]
                            force_me_target = True
                            break
                    if owner in ("我", _norm_quote(me["name"])):
                        cand = [me]
                    else:
                        cand = [p for p in circle_people
                                if _norm_quote(p["name"]) == owner]
                    if len(cand) == 1:
                        aid = cand[0]["id"]
                        members = set()
                        for er in db.list_relations(circle_id):
                            if er["kind"] not in kinds:
                                continue
                            if er["a_id"] == aid:
                                members.add(er["b_id"])
                            elif er["b_id"] == aid:
                                members.add(er["a_id"])
                    break
                if members is not None and not force_me_target:
                    # claim 的 phrase 没带「我和」,但**原文**是「我和X的室友
                    # 都认识」的形态 → 对象只能是「我」。真机抓到过:模型把
                    # target 填成句子里别的人(Joan),Alex 的室友全连错了对象。
                    if ("我和" + npz) in norm_src or ("我跟" + npz) in norm_src:
                        force_me_target = True
                if members is not None and force_me_target:
                    target_name = me["name"]
                if members is None:
                    extra_notices.append(
                        f"材料里的「{phrase}」指一群人,但没法确定具体是谁 —— "
                        f"可以用人物卡的「批量」手工勾选名单。")
                    continue

            if not members:
                extra_notices.append(
                    f"「{phrase}」按关系网找不到对应的人(还没记录这类关系),"
                    f"没有展开。")
                continue

            # 对象可能是本次材料新引入的人(库里没有)—— 不算幽灵,
            # 除非原文里也找不到这个名字(那就是模型编的)
            pt, _how_t = _match_person(target_name, all_people)
            target_id = pt["id"] if pt else None
            target_ghost = (n_images == 0 and target_id is None
                            and _norm_quote(target_name) not in norm_src)

            for mid in sorted(members):
                m_name = name_of.get(mid)
                if not m_name or mid == target_id or m_name == target_name:
                    continue
                # 去噪①:这一对在本批已有**直接说的**关系(任意 kind)——
                # 直接说的更具体,再出一条泛泛的展开行只会自相矛盾
                if frozenset((_norm_quote(m_name), _norm_quote(target_name))) \
                        in batch_pairs:
                    continue
                # 去噪②:泛泛的「点头之交」在库里该对已有任何关系时是废话
                # (已经是朋友了还说"认识",用户读着刺眼)。非点头之交的展开
                # 保持原语义:同 kind 已存在 → 标 existing_strength、默认不勾
                if kind == "点头之交" and target_id and \
                        frozenset((mid, target_id)) in db_pairs:
                    continue
                pair_key = (kind, m_name, target_name) if kind in db.DIRECTED_KINDS \
                    else (kind,) + tuple(sorted((m_name, target_name)))
                if pair_key in seen_pairs:      # 模型已直接抽过这一条就不重复
                    continue
                seen_pairs.add(pair_key)
                row = {
                    "a_name": m_name, "b_name": target_name,
                    "a_id": mid, "b_id": target_id,
                    "a_match": "exact", "b_match": _how_t,
                    "kind": kind,
                    "cat": info["cat"],
                    "glyph": db.CATEGORY_GLYPH.get(info["cat"], ""),
                    "strength": strength,
                    "evidence": evidence,
                    "evidence_ok": evidence_in_source(
                        evidence, source_text, n_images > 0),
                    # 置信地板 0.8:成员是代码按关系网查表的、evidence 是
                    # 过了校验的原句 —— 不该继承(重试)模型的低置信,否则
                    # 展开行会被前端"把握不足"规则整段默认不勾(真机用户
                    # 把这读成了"没判断上")。解释性风险由段头文案 + 逐条
                    # 勾选承担;幽灵/重复的不勾规则不走 confidence,不受影响。
                    "confidence": max(conf, 0.8),
                    "accepted": True,
                    "expanded_from": phrase,
                }
                if target_ghost:
                    row["expand_ghost"] = True
                    row["accepted"] = False
                if target_id:
                    na, nb, _d = db.normalize_pair(mid, target_id, kind)
                    if (na, nb, kind) in existing:
                        row["existing_strength"] = existing[(na, nb, kind)]
                relation_rows.append(row)

    # pre_claims:模型误当人名的「X的室友」在行级清洗时转来的,走同一套解析
    _process_claims((raw.get("group_claims") or []) + pre_claims)

    # 专注重试:主调用没标出群体说法、而确定性检测发现了模式时,发起
    # 第二次**只做标记这一件事**的小调用 —— 整句多任务负载下 4o-mini
    # 常漏标(真机 0/3 抓到过),单任务提示的服从率高得多。
    # 失败就算了,外面还有确定性提示兜底;测试环境用打桩替掉它。
    if me_in and n_images == 0 and config.LLM_SEND_RELATIONS:
        pending_hints = _unhandled_group_hints(
            norm_src, handled_claims, relation_rows,
            raw.get("notices") or [])
        if pending_hints:
            try:
                retry = _retry_group_claims(
                    source_text, pending_hints, circle_id)
            except Exception:
                retry = None
            if retry:
                _process_claims(retry.get("group_claims") or [])
                extra_notices.extend(
                    n.strip()[:200] for n in retry.get("notices", [])
                    if isinstance(n, str) and n.strip())

    # 「T也是我的朋友」确定性补行:claim 已经指认了 T,原文又含这个可以
    # 精确匹配的句式,而模型偶尔会漏掉这条**直接**关系(真机波动抓到过:
    # 展开做了、「Joan也是我的朋友」本身反而没了)。名字已知、句式可查 ——
    # 不必求模型。
    if me_in:
        for gcm in handled_claims:
            if (gcm.get("group") or "").strip() != "我的朋友":
                continue
            t = (gcm.get("target") or "").strip()
            if not t or _norm_quote(t) == _norm_quote(me["name"]):
                continue
            hit = next((frag for frag in (t + "也是我的朋友", t + "是我的朋友")
                        if _norm_quote(frag) in norm_src), None)
            if not hit:
                continue
            if frozenset((_norm_quote(me["name"]), _norm_quote(t))) in batch_pairs:
                continue                    # 模型这次没漏,别重复
            pair_key = ("朋友",) + tuple(sorted((me["name"], t)))
            if pair_key in seen_pairs:
                continue
            pt2, how2 = _match_person(t, all_people)
            tid = pt2["id"] if pt2 else None
            if tid and frozenset((me["id"], tid)) in db_pairs:
                continue                    # 库里已有 me—T 的关系,不必补
            seen_pairs.add(pair_key)
            info_f = db.RELATION_KINDS["朋友"]
            relation_rows.append({
                "a_name": me["name"], "b_name": t,
                "a_id": me["id"], "b_id": tid,
                "a_match": "exact", "b_match": how2,
                "kind": "朋友", "cat": info_f["cat"],
                "glyph": db.CATEGORY_GLYPH.get(info_f["cat"], ""),
                "strength": 2,
                "evidence": hit,
                "evidence_ok": evidence_in_source(hit, source_text, n_images > 0),
                "confidence": 0.9,
                "accepted": True,
                "expanded_from": "",
            })

    # 确定性兜底:原文里像群体说法的模式,模型既没标 claim、也没有展开行
    # 或 notice → 主动提示。最坏情况从"静默丢"变成"明确告知"。
    # 检测不随 LLM_SEND_RELATIONS 关闭(关闭形态同样会静默丢),只切话术:
    # 关着时劝"重发"是假希望,直指批量。有图时不测(原文可能只是样板文,
    # 与 evidence 放行的口径一致)。
    hints = _unhandled_group_hints(
        norm_src, handled_claims, relation_rows,
        raw.get("notices") or [])
    if hints and n_images == 0:
        frag = "」「".join(hints)
        if config.LLM_SEND_RELATIONS:
            extra_notices.append(
                f"材料里的「{frag}」像是指一群人,AI 没能自动展开 —— "
                f"可以换个说法重发(比如「我所有朋友都认识她」),"
                f"或用人物卡的「批量」手工勾选。")
        else:
            extra_notices.append(
                f"材料里的「{frag}」像是指一群人;已关闭发送关系网,"
                f"AI 不会展开 —— 用人物卡的「批量」手工勾选。")

    # 传递推导:A-C 和 B-C 都是室友 -> 建议 A-B 也是。
    #
    # **刻意不交给模型做**:这是个确定性的图运算,交给模型会时对时错,
    # 代码来做能给出可复述的依据("因为两人都是 Alex 的室友")。
    # 群体说法同理:模型只负责"读懂这句话"(group_claims),名单由上面的
    # 代码按关系网枚举 —— 各干各擅长的。
    #
    # 结果和抽取出来的关系放进**同一个数组**,靠 derived 标记区分;
    # 审核界面分段渲染,但 data-i 仍用原数组下标。
    derived = analysis.derive_transitive(circle_id, relation_rows)

    # 模型的说明(群体说法无法展开时的原因)+ 代码展开时发现的问题。
    # 滤空、限长、限条数 —— 别让模型往用户脸上贴大字报。
    notices = [n.strip()[:200] for n in raw.get("notices", [])
               if isinstance(n, str) and n.strip()]
    notices = (notices + extra_notices)[:5]
    notices = [n[:200] for n in notices]

    return {
        "source": source_text[:4000],
        "images": n_images,
        "circle_id": circle_id,
        "model": config.LLM_MODEL,
        "persons": person_rows,
        "relations": relation_rows + derived,
        "notices": notices,
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
