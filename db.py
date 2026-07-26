"""SQLite 存储层:建表、迁移、增删改查。

两个贯穿全局的约定:

1. 无向关系统一按 a_id < b_id 归一化存储,所以"张三-李四"和"李四-张三"
   永远是同一条记录,不会出现重复边。有向关系(上下级、师徒、提携)
   保持 a→b 的语义不做交换。

2. 任何写操作都会 bump meta 表里的 graph_version。布局和分析结果的缓存
   以这个版本号为键,数据一变缓存自然失效,不需要手动清。
"""

import json
import sqlite3
import time
from contextlib import contextmanager

import config

# ---- 关系类型 ----
# 分正/负/中三类。sign 只用于校验录入的 strength 方向是否合理,
# 真正参与计算的是 strength 本身。
RELATION_KINDS = {
    # 正向
    "盟友": 1, "朋友": 1, "师徒": 1, "提携": 1, "同乡同学": 1, "利益共同体": 1,
    # 负向
    "竞争": -1, "敌对": -1, "宿怨": -1, "利益冲突": -1,
    # 中性
    "上下级": 0, "同事": 0, "认识": 0,
}

# 天然有方向的关系:a 是师傅/上级/提携者,b 是徒弟/下级/被提携者
DIRECTED_KINDS = {"师徒", "提携", "上下级"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS person (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL UNIQUE,
    aliases     TEXT NOT NULL DEFAULT '',
    dept        TEXT NOT NULL DEFAULT '',
    title       TEXT NOT NULL DEFAULT '',
    level       INTEGER NOT NULL DEFAULT 0,
    tags        TEXT NOT NULL DEFAULT '',
    notes       TEXT NOT NULL DEFAULT '',
    is_me       INTEGER NOT NULL DEFAULT 0,
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS relation (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    a_id        INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    b_id        INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    strength    INTEGER NOT NULL DEFAULT 0,
    directed    INTEGER NOT NULL DEFAULT 0,
    confidence  REAL NOT NULL DEFAULT 1.0,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    UNIQUE(a_id, b_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_relation_a ON relation(a_id);
CREATE INDEX IF NOT EXISTS idx_relation_b ON relation(b_id);

CREATE TABLE IF NOT EXISTS event (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    happened_at REAL NOT NULL,
    text        TEXT NOT NULL,
    people_json TEXT NOT NULL DEFAULT '[]',
    created_at  REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS event_relation (
    event_id    INTEGER NOT NULL REFERENCES event(id) ON DELETE CASCADE,
    relation_id INTEGER NOT NULL REFERENCES relation(id) ON DELETE CASCADE,
    delta       INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (event_id, relation_id)
);

CREATE TABLE IF NOT EXISTS import_draft (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    kind         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'pending',
    created_at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS layout_cache (
    key           TEXT PRIMARY KEY,
    value_json    TEXT NOT NULL,
    graph_version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""

_conn = None


def connect():
    global _conn
    if _conn is None:
        config.ensure_dirs()
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA foreign_keys = ON")
        _conn.execute("PRAGMA journal_mode = WAL")
        _conn.executescript(SCHEMA)
        if get_meta("graph_version") is None:
            set_meta("graph_version", "1")
        _conn.commit()
    return _conn


@contextmanager
def tx():
    conn = connect()
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise


# ---------- meta / 版本 ----------

def get_meta(key, default=None):
    cur = _conn.execute("SELECT value FROM meta WHERE key=?", (key,))
    row = cur.fetchone()
    return row["value"] if row else default


def set_meta(key, value):
    _conn.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def graph_version():
    connect()
    return int(get_meta("graph_version", "1"))


def bump_version():
    """图数据变了 —— 让所有布局/分析缓存失效。"""
    set_meta("graph_version", graph_version() + 1)


# ---------- 人员 ----------

def list_people():
    conn = connect()
    return [dict(r) for r in conn.execute(
        "SELECT * FROM person ORDER BY dept, name")]


def get_person(pid):
    conn = connect()
    row = conn.execute("SELECT * FROM person WHERE id=?", (pid,)).fetchone()
    return dict(row) if row else None


def find_person_by_name(name):
    """精确匹配姓名,再匹配别名。"""
    conn = connect()
    name = (name or "").strip()
    if not name:
        return None
    row = conn.execute("SELECT * FROM person WHERE name=?", (name,)).fetchone()
    if row:
        return dict(row)
    for r in conn.execute("SELECT * FROM person WHERE aliases != ''"):
        aliases = [a.strip() for a in r["aliases"].replace("，", ",").split(",")]
        if name in aliases:
            return dict(r)
    return None


def upsert_person(name, dept="", title="", level=0, aliases="", tags="",
                  notes="", is_me=None):
    """按姓名新建或更新。返回 (person_id, created?)。"""
    name = (name or "").strip()
    if not name:
        raise ValueError("姓名不能为空")
    now = time.time()
    with tx() as conn:
        existing = conn.execute(
            "SELECT * FROM person WHERE name=?", (name,)).fetchone()
        if existing:
            fields, params = [], []
            for col, val in (("dept", dept), ("title", title),
                             ("aliases", aliases), ("tags", tags),
                             ("notes", notes)):
                if val:                       # 空值不覆盖已有内容
                    fields.append(f"{col}=?")
                    params.append(val)
            if level:
                fields.append("level=?")
                params.append(level)
            if is_me is not None:
                fields.append("is_me=?")
                params.append(1 if is_me else 0)
            if fields:
                fields.append("updated_at=?")
                params.extend([now, existing["id"]])
                conn.execute(
                    f"UPDATE person SET {', '.join(fields)} WHERE id=?", params)
                bump_version()
            return existing["id"], False

        cur = conn.execute(
            "INSERT INTO person(name,aliases,dept,title,level,tags,notes,"
            "is_me,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
            (name, aliases, dept, title, level, tags, notes,
             1 if is_me else 0, now, now))
        bump_version()
        return cur.lastrowid, True


def update_person(pid, **fields):
    allowed = {"name", "aliases", "dept", "title", "level", "tags",
               "notes", "is_me"}
    sets, params = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            params.append(v)
    if not sets:
        return False
    sets.append("updated_at=?")
    params.extend([time.time(), pid])
    with tx() as conn:
        conn.execute(f"UPDATE person SET {', '.join(sets)} WHERE id=?", params)
        bump_version()
    return True


def delete_person(pid):
    with tx() as conn:
        conn.execute("DELETE FROM person WHERE id=?", (pid,))
        bump_version()


def set_me(pid):
    """标记"我"是谁 —— 拉拢度计算要用。同时只能有一个。"""
    with tx() as conn:
        conn.execute("UPDATE person SET is_me=0 WHERE is_me=1")
        conn.execute("UPDATE person SET is_me=1 WHERE id=?", (pid,))
        bump_version()


def get_me():
    conn = connect()
    row = conn.execute("SELECT * FROM person WHERE is_me=1").fetchone()
    return dict(row) if row else None


# ---------- 关系 ----------

def normalize_pair(a_id, b_id, kind):
    """无向关系统一成 a_id < b_id,有向关系保持原方向。"""
    directed = 1 if kind in DIRECTED_KINDS else 0
    if not directed and a_id > b_id:
        a_id, b_id = b_id, a_id
    return a_id, b_id, directed


def list_relations():
    conn = connect()
    return [dict(r) for r in conn.execute("SELECT * FROM relation")]


def list_relations_detailed():
    conn = connect()
    return [dict(r) for r in conn.execute("""
        SELECT r.*, pa.name AS a_name, pb.name AS b_name
        FROM relation r
        JOIN person pa ON pa.id = r.a_id
        JOIN person pb ON pb.id = r.b_id
        ORDER BY r.updated_at DESC
    """)]


def relations_of(pid):
    conn = connect()
    return [dict(r) for r in conn.execute("""
        SELECT r.*, pa.name AS a_name, pb.name AS b_name
        FROM relation r
        JOIN person pa ON pa.id = r.a_id
        JOIN person pb ON pb.id = r.b_id
        WHERE r.a_id=? OR r.b_id=?
        ORDER BY ABS(r.strength) DESC
    """, (pid, pid))]


def upsert_relation(a_id, b_id, kind, strength=0, notes="", confidence=1.0):
    if a_id == b_id:
        raise ValueError("不能给同一个人建立关系")
    if kind not in RELATION_KINDS:
        raise ValueError(f"未知的关系类型:{kind}")
    strength = max(-3, min(3, int(strength)))
    a_id, b_id, directed = normalize_pair(a_id, b_id, kind)
    now = time.time()
    with tx() as conn:
        row = conn.execute(
            "SELECT id FROM relation WHERE a_id=? AND b_id=? AND kind=?",
            (a_id, b_id, kind)).fetchone()
        if row:
            conn.execute(
                "UPDATE relation SET strength=?, notes=?, confidence=?, "
                "updated_at=? WHERE id=?",
                (strength, notes, confidence, now, row["id"]))
            rid = row["id"]
        else:
            cur = conn.execute(
                "INSERT INTO relation(a_id,b_id,kind,strength,directed,"
                "confidence,notes,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?)",
                (a_id, b_id, kind, strength, directed, confidence, notes,
                 now, now))
            rid = cur.lastrowid
        bump_version()
        return rid


def delete_relation(rid):
    with tx() as conn:
        conn.execute("DELETE FROM relation WHERE id=?", (rid,))
        bump_version()


# ---------- 事件 ----------

def add_event(text, people_ids, happened_at=None):
    now = time.time()
    with tx() as conn:
        cur = conn.execute(
            "INSERT INTO event(happened_at,text,people_json,created_at) "
            "VALUES(?,?,?,?)",
            (happened_at or now, text, json.dumps(people_ids,
                                                  ensure_ascii=False), now))
        return cur.lastrowid


def list_events(limit=200):
    conn = connect()
    return [dict(r) for r in conn.execute(
        "SELECT * FROM event ORDER BY happened_at DESC LIMIT ?", (limit,))]


def events_for_person(pid):
    """涉及某人的事件。people_json 是 id 数组,用 JSON 文本匹配即可 ——
    百来号人的量级不值得为此建关联表。"""
    conn = connect()
    out = []
    for r in conn.execute("SELECT * FROM event ORDER BY happened_at DESC"):
        try:
            ids = json.loads(r["people_json"])
        except (json.JSONDecodeError, TypeError):
            ids = []
        if pid in ids:
            out.append(dict(r))
    return out


def link_event_relation(event_id, relation_id, delta=0):
    with tx() as conn:
        conn.execute(
            "INSERT INTO event_relation(event_id,relation_id,delta) "
            "VALUES(?,?,?) ON CONFLICT(event_id,relation_id) "
            "DO UPDATE SET delta=excluded.delta",
            (event_id, relation_id, delta))


def delete_event(eid):
    with tx() as conn:
        conn.execute("DELETE FROM event WHERE id=?", (eid,))


# ---------- 缓存 ----------

def cache_get(key):
    conn = connect()
    row = conn.execute(
        "SELECT value_json, graph_version FROM layout_cache WHERE key=?",
        (key,)).fetchone()
    if row and row["graph_version"] == graph_version():
        return json.loads(row["value_json"])
    return None


def cache_put(key, value):
    with tx() as conn:
        conn.execute(
            "INSERT INTO layout_cache(key,value_json,graph_version) "
            "VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET "
            "value_json=excluded.value_json, "
            "graph_version=excluded.graph_version",
            (key, json.dumps(value, ensure_ascii=False), graph_version()))


# ---------- 导入草稿 ----------

def add_draft(kind, payload):
    with tx() as conn:
        cur = conn.execute(
            "INSERT INTO import_draft(kind,payload_json,status,created_at) "
            "VALUES(?,?,?,?)",
            (kind, json.dumps(payload, ensure_ascii=False), "pending",
             time.time()))
        return cur.lastrowid


def get_draft(did):
    conn = connect()
    row = conn.execute(
        "SELECT * FROM import_draft WHERE id=?", (did,)).fetchone()
    if not row:
        return None
    d = dict(row)
    d["payload"] = json.loads(d.pop("payload_json"))
    return d


def set_draft_status(did, status):
    with tx() as conn:
        conn.execute("UPDATE import_draft SET status=? WHERE id=?",
                     (status, did))


# ---------- 备份 ----------

def export_all():
    conn = connect()
    return {
        "version": 1,
        "exported_at": time.time(),
        "people": [dict(r) for r in conn.execute("SELECT * FROM person")],
        "relations": [dict(r) for r in conn.execute("SELECT * FROM relation")],
        "events": [dict(r) for r in conn.execute("SELECT * FROM event")],
    }


def import_all(payload, replace=False):
    """从备份恢复。replace=True 会先清空现有数据。

    人员按姓名去重,关系按 (a,b,kind) 去重,所以重复导入同一份备份是幂等的。
    """
    people = payload.get("people", [])
    relations = payload.get("relations", [])
    events = payload.get("events", [])

    if replace:
        with tx() as conn:
            conn.execute("DELETE FROM event_relation")
            conn.execute("DELETE FROM event")
            conn.execute("DELETE FROM relation")
            conn.execute("DELETE FROM person")
            conn.execute("DELETE FROM layout_cache")

    # 旧 id -> 新 id
    id_map = {}
    for p in people:
        new_id, _ = upsert_person(
            p.get("name", ""), p.get("dept", ""), p.get("title", ""),
            p.get("level", 0), p.get("aliases", ""), p.get("tags", ""),
            p.get("notes", ""), bool(p.get("is_me", 0)) or None)
        id_map[p.get("id")] = new_id

    n_rel = 0
    for r in relations:
        a, b = id_map.get(r.get("a_id")), id_map.get(r.get("b_id"))
        if a and b and r.get("kind") in RELATION_KINDS:
            upsert_relation(a, b, r["kind"], r.get("strength", 0),
                            r.get("notes", ""), r.get("confidence", 1.0))
            n_rel += 1

    n_ev = 0
    for e in events:
        try:
            old_ids = json.loads(e.get("people_json", "[]"))
        except (json.JSONDecodeError, TypeError):
            old_ids = []
        new_ids = [id_map[i] for i in old_ids if i in id_map]
        add_event(e.get("text", ""), new_ids, e.get("happened_at"))
        n_ev += 1

    return {"people": len(id_map), "relations": n_rel, "events": n_ev}
