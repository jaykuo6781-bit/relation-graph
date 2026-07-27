"""SQLite 存储层:建表、迁移、增删改查。

三个贯穿全局的约定:

1. **人是全局唯一的,关系归属于圈子。**
   同一个张三只有一条 person 记录,不会因为既是同事又是同学就出现两份。
   但"张三—李四"这对人在公司圈可以是"竞争",在同学圈可以是"死党",
   两条关系互不干扰 —— 因为 relation 上带 circle_id。

2. 无向关系统一按 a_id < b_id 归一化存储,所以"张三-李四"和"李四-张三"
   永远是同一条记录。有向关系(师徒、提携、上下级、单恋…)保持 a→b 的语义。

3. 任何写操作都会 bump meta 表里的 graph_version。布局和分析结果的缓存
   以这个版本号为键,数据一变缓存自然失效,不需要手动清。
"""

import json
import sqlite3
import time
from contextlib import contextmanager

import config

# ============================================================
#  关系词表
# ============================================================
# 从 v1 的纯职场词表扩到全场景。每个类型带四个属性:
#   cat       类别 —— 决定图上用哪个标记符(不占颜色,颜色留给正负)
#   sign      正负倾向 —— 只用于给默认强度和校验,真正参与计算的是 strength
#   directed  是否天然有方向(a 是师傅/上级/暗恋者)
#   default   录入时的默认强度

RELATION_CATEGORIES = ["情感", "利益", "职场", "社交", "学缘", "亲缘"]

# 每个类别在图上的标记符 —— 不依赖颜色也能区分类别
CATEGORY_GLYPH = {
    "情感": "♥", "利益": "¥", "职场": "▪",
    "社交": "●", "学缘": "✎", "亲缘": "⌂",
}

RELATION_KINDS = {
    # ---- 情感 ----
    "情侣":     {"cat": "情感", "sign": 1,  "directed": 0, "default": 3},
    "暧昧":     {"cat": "情感", "sign": 1,  "directed": 0, "default": 2},
    "好感":     {"cat": "情感", "sign": 1,  "directed": 1, "default": 1},
    "单恋":     {"cat": "情感", "sign": 1,  "directed": 1, "default": 2},
    "前任":     {"cat": "情感", "sign": 0,  "directed": 0, "default": 0},
    "情敌":     {"cat": "情感", "sign": -1, "directed": 0, "default": -2},
    # ---- 利益 ----
    "利益往来": {"cat": "利益", "sign": 1,  "directed": 0, "default": 1},
    "合作":     {"cat": "利益", "sign": 1,  "directed": 0, "default": 2},
    "金钱借贷": {"cat": "利益", "sign": 0,  "directed": 1, "default": 0},
    "竞争":     {"cat": "利益", "sign": -1, "directed": 0, "default": -2},
    "利益冲突": {"cat": "利益", "sign": -1, "directed": 0, "default": -2},
    # ---- 职场 ----
    "上下级":   {"cat": "职场", "sign": 0,  "directed": 1, "default": 1},
    "同事":     {"cat": "职场", "sign": 0,  "directed": 0, "default": 1},
    "师徒":     {"cat": "职场", "sign": 1,  "directed": 1, "default": 2},
    "提携":     {"cat": "职场", "sign": 1,  "directed": 1, "default": 2},
    "派系盟友": {"cat": "职场", "sign": 1,  "directed": 0, "default": 3},
    # ---- 社交 ----
    "朋友":     {"cat": "社交", "sign": 1,  "directed": 0, "default": 2},
    "死党":     {"cat": "社交", "sign": 1,  "directed": 0, "default": 3},
    "点头之交": {"cat": "社交", "sign": 0,  "directed": 0, "default": 0},
    # 泛用的轻微负面 —— 这一项是补一个真实存在的缺口,不是凑数。
    # 在它之前,五个负向关系全是重型(情敌 -2、竞争 -2、利益冲突 -2、
    # 敌对 -3、宿怨 -3),而 AI 抽取的 schema 用 enum 强制模型必须从词表里
    # 选一个。于是「有点不开心」「闹了别扭」这种说不清的负面,模型只能
    # 硬套一个具体类型 —— 真实案例:两个室友因为提前退租不愉快,
    # 被抽成了「情敌」。它需要的那个选项当时根本不存在。
    "有摩擦":   {"cat": "社交", "sign": -1, "directed": 0, "default": -1},
    "敌对":     {"cat": "社交", "sign": -1, "directed": 0, "default": -3},
    "宿怨":     {"cat": "社交", "sign": -1, "directed": 0, "default": -3},
    # ---- 学缘 ----
    "同学":     {"cat": "学缘", "sign": 0,  "directed": 0, "default": 1},
    "室友":     {"cat": "学缘", "sign": 1,  "directed": 0, "default": 2},
    "师生":     {"cat": "学缘", "sign": 1,  "directed": 1, "default": 1},
    # ---- 亲缘 ----
    "家人":     {"cat": "亲缘", "sign": 1,  "directed": 0, "default": 3},
    "亲戚":     {"cat": "亲缘", "sign": 1,  "directed": 0, "default": 2},
}

DIRECTED_KINDS = {k for k, v in RELATION_KINDS.items() if v["directed"]}

# v1 的旧类型 → v2 新类型。迁移和导入旧备份时用。
LEGACY_KIND_MAP = {
    "盟友": "派系盟友",
    "同乡同学": "同学",
    "利益共同体": "合作",
    "认识": "点头之交",
}

# 圈子类型 → 建圈子时优先展开哪几类关系(只是排序建议,不做限制)
CIRCLE_KINDS = {
    "公司": ["职场", "利益", "社交"],
    "班级": ["学缘", "情感", "社交"],
    "家族": ["亲缘", "情感", "社交"],
    "朋友": ["社交", "情感", "利益"],
    "自定义": list(RELATION_CATEGORIES),
}


def normalize_kind(kind):
    """把旧类型名映射到新类型名;已经是新的就原样返回。"""
    kind = (kind or "").strip()
    return LEGACY_KIND_MAP.get(kind, kind)


def kind_info(kind):
    return RELATION_KINDS.get(normalize_kind(kind))


# ============================================================
#  表结构
# ============================================================

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

CREATE TABLE IF NOT EXISTS circle (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    kind       TEXT NOT NULL DEFAULT '自定义',
    icon       TEXT NOT NULL DEFAULT '',
    sort       INTEGER NOT NULL DEFAULT 0,
    notes      TEXT NOT NULL DEFAULT '',
    created_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS person_circle (
    person_id INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    circle_id INTEGER NOT NULL REFERENCES circle(id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT '',
    note      TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (person_id, circle_id)
);
CREATE INDEX IF NOT EXISTS idx_pc_circle ON person_circle(circle_id);

CREATE TABLE IF NOT EXISTS relation (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    circle_id   INTEGER NOT NULL REFERENCES circle(id) ON DELETE CASCADE,
    a_id        INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    b_id        INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL,
    strength    INTEGER NOT NULL DEFAULT 0,
    directed    INTEGER NOT NULL DEFAULT 0,
    confidence  REAL NOT NULL DEFAULT 1.0,
    notes       TEXT NOT NULL DEFAULT '',
    created_at  REAL NOT NULL,
    updated_at  REAL NOT NULL,
    UNIQUE(circle_id, a_id, b_id, kind)
);
CREATE INDEX IF NOT EXISTS idx_relation_a ON relation(a_id);
CREATE INDEX IF NOT EXISTS idx_relation_b ON relation(b_id);

CREATE TABLE IF NOT EXISTS event (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    circle_id   INTEGER,
    happened_at REAL NOT NULL,
    text        TEXT NOT NULL,
    people_json TEXT NOT NULL DEFAULT '[]',
    source      TEXT NOT NULL DEFAULT '',
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

# 这两个索引引用 circle_id,而 v1 的老表上还没有这一列 —— 必须等迁移完成
# 才能建,否则 executescript 会直接报 "no such column: circle_id"。
INDEXES_AFTER_MIGRATION = """
CREATE INDEX IF NOT EXISTS idx_relation_circle ON relation(circle_id);
CREATE INDEX IF NOT EXISTS idx_event_circle ON event(circle_id);
"""

_conn = None


# ============================================================
#  连接与迁移
# ============================================================

def _table_columns(conn, table):
    return {r["name"] for r in conn.execute(f"PRAGMA table_info({table})")}


def _migrate_v1_to_v2(conn):
    """v1(无圈子)→ v2(有圈子)。

    v1 的 relation 没有 circle_id,唯一约束是 (a_id,b_id,kind)。
    SQLite 改不了约束,只能重建表搬数据。存量关系全部归入默认圈子,
    一条都不能丢 —— 这是整个升级里唯一有破坏性风险的地方。
    """
    rel_cols = _table_columns(conn, "relation")
    if not rel_cols or "circle_id" in rel_cols:
        return False                      # 新库,或已经是 v2

    n_before = conn.execute("SELECT COUNT(*) c FROM relation").fetchone()["c"]

    # 1. 准备一个默认圈子承接存量数据
    row = conn.execute("SELECT id FROM circle ORDER BY id LIMIT 1").fetchone()
    if row:
        default_cid = row["id"]
    else:
        cur = conn.execute(
            "INSERT INTO circle(name,kind,icon,sort,notes,created_at) "
            "VALUES(?,?,?,?,?,?)",
            ("公司圈", "公司", "🏢", 0, "升级时自动创建,存量关系都归在这里",
             time.time()))
        default_cid = cur.lastrowid

    # 2. 重建 relation 表
    conn.execute("ALTER TABLE relation RENAME TO relation_v1")
    conn.executescript("""
        CREATE TABLE relation (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            circle_id   INTEGER NOT NULL REFERENCES circle(id) ON DELETE CASCADE,
            a_id        INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
            b_id        INTEGER NOT NULL REFERENCES person(id) ON DELETE CASCADE,
            kind        TEXT NOT NULL,
            strength    INTEGER NOT NULL DEFAULT 0,
            directed    INTEGER NOT NULL DEFAULT 0,
            confidence  REAL NOT NULL DEFAULT 1.0,
            notes       TEXT NOT NULL DEFAULT '',
            created_at  REAL NOT NULL,
            updated_at  REAL NOT NULL,
            UNIQUE(circle_id, a_id, b_id, kind)
        );
    """)
    conn.execute(
        "INSERT INTO relation "
        "(id,circle_id,a_id,b_id,kind,strength,directed,confidence,notes,"
        " created_at,updated_at) "
        "SELECT id,?,a_id,b_id,kind,strength,directed,confidence,notes,"
        "       created_at,updated_at FROM relation_v1",
        (default_cid,))
    conn.execute("DROP TABLE relation_v1")
    conn.executescript("""
        CREATE INDEX IF NOT EXISTS idx_relation_a ON relation(a_id);
        CREATE INDEX IF NOT EXISTS idx_relation_b ON relation(b_id);
        CREATE INDEX IF NOT EXISTS idx_relation_circle ON relation(circle_id);
    """)

    # 3. 旧类型名映射到新词表
    for old, new in LEGACY_KIND_MAP.items():
        conn.execute("UPDATE relation SET kind=? WHERE kind=?", (new, old))

    # 4. event 加 circle_id / source
    ev_cols = _table_columns(conn, "event")
    if "circle_id" not in ev_cols:
        conn.execute("ALTER TABLE event ADD COLUMN circle_id INTEGER")
        conn.execute("UPDATE event SET circle_id=?", (default_cid,))
    if "source" not in ev_cols:
        conn.execute("ALTER TABLE event ADD COLUMN source TEXT NOT NULL DEFAULT ''")

    # 5. 所有存量人员加入默认圈子
    conn.execute(
        "INSERT OR IGNORE INTO person_circle(person_id,circle_id) "
        "SELECT id,? FROM person", (default_cid,))

    # 6. 布局缓存作废
    conn.execute("DELETE FROM layout_cache")

    n_after = conn.execute("SELECT COUNT(*) c FROM relation").fetchone()["c"]
    if n_after != n_before:
        raise RuntimeError(
            f"迁移异常:关系数从 {n_before} 变成 {n_after},已回滚")
    return True


def connect():
    global _conn
    if _conn is None:
        config.ensure_dirs()
        _conn = sqlite3.connect(config.DB_PATH, check_same_thread=False)
        _conn.row_factory = sqlite3.Row
        _conn.execute("PRAGMA journal_mode = WAL")

        # 迁移期间关掉外键检查 —— 重建表时会短暂出现悬空引用
        _conn.execute("PRAGMA foreign_keys = OFF")
        _conn.executescript(SCHEMA)
        try:
            _migrate_v1_to_v2(_conn)
            _conn.executescript(INDEXES_AFTER_MIGRATION)
            _conn.commit()
        except Exception:
            _conn.rollback()
            raise
        _conn.execute("PRAGMA foreign_keys = ON")

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


# ============================================================
#  meta / 版本
# ============================================================

def get_meta(key, default=None):
    row = _conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def set_meta(key, value):
    _conn.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)))


def graph_version():
    connect()
    return int(get_meta("graph_version", "1"))


def bump_version():
    set_meta("graph_version", graph_version() + 1)


# ============================================================
#  圈子
# ============================================================

def list_circles():
    conn = connect()
    rows = []
    for r in conn.execute("SELECT * FROM circle ORDER BY sort, id"):
        d = dict(r)
        d["people"] = conn.execute(
            "SELECT COUNT(*) c FROM person_circle WHERE circle_id=?",
            (d["id"],)).fetchone()["c"]
        d["relations"] = conn.execute(
            "SELECT COUNT(*) c FROM relation WHERE circle_id=?",
            (d["id"],)).fetchone()["c"]
        rows.append(d)
    return rows


def get_circle(cid):
    conn = connect()
    row = conn.execute("SELECT * FROM circle WHERE id=?", (cid,)).fetchone()
    return dict(row) if row else None


def create_circle(name, kind="自定义", icon="", notes=""):
    name = (name or "").strip()
    if not name:
        raise ValueError("圈子名不能为空")
    with tx() as conn:
        exists = conn.execute(
            "SELECT id FROM circle WHERE name=?", (name,)).fetchone()
        if exists:
            return exists["id"]
        sort = conn.execute(
            "SELECT COALESCE(MAX(sort),0)+1 s FROM circle").fetchone()["s"]
        cur = conn.execute(
            "INSERT INTO circle(name,kind,icon,sort,notes,created_at) "
            "VALUES(?,?,?,?,?,?)",
            (name, kind, icon, sort, notes, time.time()))
        bump_version()
        return cur.lastrowid


def update_circle(cid, **fields):
    allowed = {"name", "kind", "icon", "sort", "notes"}
    sets, params = [], []
    for k, v in fields.items():
        if k in allowed:
            sets.append(f"{k}=?")
            params.append(v)
    if not sets:
        return False
    params.append(cid)
    with tx() as conn:
        conn.execute(f"UPDATE circle SET {', '.join(sets)} WHERE id=?", params)
        bump_version()
    return True


def delete_circle(cid):
    """删圈子只删这个圈子里的关系和成员归属,**不删人**。

    人可能同时属于别的圈子,删掉就把别处的数据也毁了。
    """
    with tx() as conn:
        conn.execute("DELETE FROM relation WHERE circle_id=?", (cid,))
        conn.execute("DELETE FROM person_circle WHERE circle_id=?", (cid,))
        conn.execute("UPDATE event SET circle_id=NULL WHERE circle_id=?", (cid,))
        conn.execute("DELETE FROM circle WHERE id=?", (cid,))
        conn.execute("DELETE FROM layout_cache")
        bump_version()


def default_circle_id():
    """没有任何圈子时自动建一个,保证 UI 永远有得选。"""
    conn = connect()
    row = conn.execute("SELECT id FROM circle ORDER BY sort, id LIMIT 1").fetchone()
    if row:
        return row["id"]
    return create_circle("我的圈子", "自定义", "🌐")


def add_to_circle(person_id, circle_id, role="", note=""):
    with tx() as conn:
        conn.execute(
            "INSERT INTO person_circle(person_id,circle_id,role,note) "
            "VALUES(?,?,?,?) ON CONFLICT(person_id,circle_id) "
            "DO UPDATE SET role=CASE WHEN excluded.role<>'' THEN excluded.role "
            "ELSE role END",
            (person_id, circle_id, role, note))
        bump_version()


def remove_from_circle(person_id, circle_id):
    """把人移出圈子,同时删掉他在这个圈子里的关系(但人本身还在)。"""
    with tx() as conn:
        conn.execute(
            "DELETE FROM relation WHERE circle_id=? AND (a_id=? OR b_id=?)",
            (circle_id, person_id, person_id))
        conn.execute(
            "DELETE FROM person_circle WHERE circle_id=? AND person_id=?",
            (circle_id, person_id))
        bump_version()


def circles_of(person_id):
    conn = connect()
    return [dict(r) for r in conn.execute(
        "SELECT c.* FROM circle c JOIN person_circle pc ON pc.circle_id=c.id "
        "WHERE pc.person_id=? ORDER BY c.sort, c.id", (person_id,))]


# ============================================================
#  人员
# ============================================================

def list_people(circle_id=None):
    conn = connect()
    if circle_id:
        sql = ("SELECT p.* FROM person p "
               "JOIN person_circle pc ON pc.person_id=p.id "
               "WHERE pc.circle_id=? ORDER BY p.dept, p.name")
        return [dict(r) for r in conn.execute(sql, (circle_id,))]
    return [dict(r) for r in conn.execute(
        "SELECT * FROM person ORDER BY dept, name")]


def get_person(pid):
    conn = connect()
    row = conn.execute("SELECT * FROM person WHERE id=?", (pid,)).fetchone()
    return dict(row) if row else None


def find_person_by_name(name):
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


def add_alias(pid, alias):
    """给某个人补一个别名。已有则原样返回,不会重复追加。

    别名存成逗号分隔的一列(见 find_person_by_name 的解析方式)。
    主要用途:AI 把「张伟」认成「张玮」并被人工确认为同一人之后,
    把模型用的那个写法记下来,下次就能走精确匹配,不必再让人确认一遍。
    """
    alias = (alias or "").strip()
    if not alias or not pid:
        return False
    with tx() as conn:
        row = conn.execute("SELECT name, aliases FROM person WHERE id=?",
                           (pid,)).fetchone()
        if not row:
            return False
        cur = [a.strip() for a in (row["aliases"] or "").replace("，", ",").split(",")]
        cur = [a for a in cur if a]
        if alias == row["name"] or alias in cur:
            return False
        cur.append(alias)
        conn.execute("UPDATE person SET aliases=?, updated_at=? WHERE id=?",
                     (",".join(cur), time.time(), pid))
        bump_version()
    return True


def upsert_person(name, dept="", title="", level=0, aliases="", tags="",
                  notes="", is_me=None, circle_id=None):
    """按姓名新建或更新。返回 (person_id, created?)。

    给了 circle_id 就顺带把人加进那个圈子 —— 录入时不用再手动管成员关系。
    """
    name = (name or "").strip()
    if not name:
        raise ValueError("姓名不能为空")
    now = time.time()
    with tx() as conn:
        existing = conn.execute(
            "SELECT * FROM person WHERE name=?", (name,)).fetchone()
        if existing:
            pid, created = existing["id"], False
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
                params.extend([now, pid])
                conn.execute(
                    f"UPDATE person SET {', '.join(fields)} WHERE id=?", params)
                bump_version()
        else:
            cur = conn.execute(
                "INSERT INTO person(name,aliases,dept,title,level,tags,notes,"
                "is_me,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)",
                (name, aliases, dept, title, level, tags, notes,
                 1 if is_me else 0, now, now))
            pid, created = cur.lastrowid, True
            bump_version()

        if circle_id:
            conn.execute(
                "INSERT OR IGNORE INTO person_circle(person_id,circle_id) "
                "VALUES(?,?)", (pid, circle_id))
        return pid, created


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
    """彻底删人 —— 所有圈子里跟他相关的关系都会消失。"""
    with tx() as conn:
        conn.execute("DELETE FROM person WHERE id=?", (pid,))
        conn.execute("DELETE FROM layout_cache")
        bump_version()


def set_me(pid):
    with tx() as conn:
        conn.execute("UPDATE person SET is_me=0 WHERE is_me=1")
        conn.execute("UPDATE person SET is_me=1 WHERE id=?", (pid,))
        bump_version()


def get_me():
    conn = connect()
    row = conn.execute("SELECT * FROM person WHERE is_me=1").fetchone()
    return dict(row) if row else None


# ============================================================
#  关系
# ============================================================

def normalize_pair(a_id, b_id, kind):
    """无向关系统一成 a_id < b_id,有向关系保持原方向。"""
    directed = 1 if normalize_kind(kind) in DIRECTED_KINDS else 0
    if not directed and a_id > b_id:
        a_id, b_id = b_id, a_id
    return a_id, b_id, directed


def list_relations(circle_id=None):
    conn = connect()
    if circle_id:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM relation WHERE circle_id=?", (circle_id,))]
    return [dict(r) for r in conn.execute("SELECT * FROM relation")]


def list_relations_detailed(circle_id=None):
    conn = connect()
    sql = """
        SELECT r.*, pa.name AS a_name, pb.name AS b_name, c.name AS circle_name
        FROM relation r
        JOIN person pa ON pa.id = r.a_id
        JOIN person pb ON pb.id = r.b_id
        JOIN circle c  ON c.id  = r.circle_id
    """
    params = ()
    if circle_id:
        sql += " WHERE r.circle_id=?"
        params = (circle_id,)
    sql += " ORDER BY r.updated_at DESC"
    return [dict(r) for r in conn.execute(sql, params)]


def relations_of(pid, circle_id=None):
    conn = connect()
    sql = """
        SELECT r.*, pa.name AS a_name, pb.name AS b_name, c.name AS circle_name
        FROM relation r
        JOIN person pa ON pa.id = r.a_id
        JOIN person pb ON pb.id = r.b_id
        JOIN circle c  ON c.id  = r.circle_id
        WHERE (r.a_id=? OR r.b_id=?)
    """
    params = [pid, pid]
    if circle_id:
        sql += " AND r.circle_id=?"
        params.append(circle_id)
    sql += " ORDER BY ABS(r.strength) DESC"
    return [dict(r) for r in conn.execute(sql, params)]


def get_relation(rid):
    conn = connect()
    row = conn.execute("""
        SELECT r.*, pa.name AS a_name, pb.name AS b_name, c.name AS circle_name
        FROM relation r
        JOIN person pa ON pa.id = r.a_id
        JOIN person pb ON pb.id = r.b_id
        JOIN circle c  ON c.id  = r.circle_id
        WHERE r.id=?""", (rid,)).fetchone()
    return dict(row) if row else None


def find_relations_between(a_id, b_id, circle_id=None):
    """两个人之间的全部关系(可能有多条,比如既是同事又是竞争)。"""
    conn = connect()
    lo, hi = min(a_id, b_id), max(a_id, b_id)
    sql = """
        SELECT r.*, pa.name AS a_name, pb.name AS b_name, c.name AS circle_name
        FROM relation r
        JOIN person pa ON pa.id = r.a_id
        JOIN person pb ON pb.id = r.b_id
        JOIN circle c  ON c.id  = r.circle_id
        WHERE ((r.a_id=? AND r.b_id=?) OR (r.a_id=? AND r.b_id=?))
    """
    params = [lo, hi, hi, lo]
    if circle_id:
        sql += " AND r.circle_id=?"
        params.append(circle_id)
    return [dict(r) for r in conn.execute(sql, params)]


def upsert_relation(circle_id, a_id, b_id, kind, strength=None, notes="",
                    confidence=1.0):
    if a_id == b_id:
        raise ValueError("不能给同一个人建立关系")
    kind = normalize_kind(kind)
    info = RELATION_KINDS.get(kind)
    if info is None:
        raise ValueError(f"未知的关系类型:{kind}")
    if not circle_id:
        raise ValueError("必须指定圈子")

    if strength is None:
        strength = info["default"]
    strength = max(-3, min(3, int(strength)))
    a_id, b_id, directed = normalize_pair(a_id, b_id, kind)
    now = time.time()

    with tx() as conn:
        # 关系涉及的人自动成为这个圈子的成员
        for pid in (a_id, b_id):
            conn.execute(
                "INSERT OR IGNORE INTO person_circle(person_id,circle_id) "
                "VALUES(?,?)", (pid, circle_id))

        row = conn.execute(
            "SELECT id FROM relation WHERE circle_id=? AND a_id=? AND b_id=? "
            "AND kind=?", (circle_id, a_id, b_id, kind)).fetchone()
        if row:
            conn.execute(
                "UPDATE relation SET strength=?, notes=?, confidence=?, "
                "updated_at=? WHERE id=?",
                (strength, notes, confidence, now, row["id"]))
            rid = row["id"]
        else:
            cur = conn.execute(
                "INSERT INTO relation(circle_id,a_id,b_id,kind,strength,"
                "directed,confidence,notes,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?,?,?,?)",
                (circle_id, a_id, b_id, kind, strength, directed, confidence,
                 notes, now, now))
            rid = cur.lastrowid
        bump_version()
        return rid


def delete_relation(rid):
    with tx() as conn:
        conn.execute("DELETE FROM relation WHERE id=?", (rid,))
        bump_version()


# ============================================================
#  事件(关系背后的故事)
# ============================================================

def add_event(text, people_ids, circle_id=None, happened_at=None, source=""):
    now = time.time()
    with tx() as conn:
        cur = conn.execute(
            "INSERT INTO event(circle_id,happened_at,text,people_json,source,"
            "created_at) VALUES(?,?,?,?,?,?)",
            (circle_id, happened_at or now, text,
             json.dumps(people_ids, ensure_ascii=False), source, now))
        return cur.lastrowid


def list_events(circle_id=None, limit=200):
    conn = connect()
    if circle_id:
        return [dict(r) for r in conn.execute(
            "SELECT * FROM event WHERE circle_id=? "
            "ORDER BY happened_at DESC LIMIT ?", (circle_id, limit))]
    return [dict(r) for r in conn.execute(
        "SELECT * FROM event ORDER BY happened_at DESC LIMIT ?", (limit,))]


def _event_people(row):
    try:
        return json.loads(row["people_json"])
    except (json.JSONDecodeError, TypeError):
        return []


def events_for_person(pid, circle_id=None):
    conn = connect()
    sql = "SELECT * FROM event"
    params = []
    if circle_id:
        sql += " WHERE circle_id=?"
        params.append(circle_id)
    sql += " ORDER BY happened_at DESC"
    return [dict(r) for r in conn.execute(sql, params)
            if pid in _event_people(r)]


def events_for_pair(a_id, b_id, circle_id=None):
    """两个人共同出现的事件 —— 这就是"他俩之间的故事"。"""
    conn = connect()
    sql = "SELECT * FROM event"
    params = []
    if circle_id:
        sql += " WHERE circle_id=?"
        params.append(circle_id)
    sql += " ORDER BY happened_at DESC"
    out = []
    for r in conn.execute(sql, params):
        ids = _event_people(r)
        if a_id in ids and b_id in ids:
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


# ============================================================
#  缓存
# ============================================================

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


# ============================================================
#  备份 / 恢复
# ============================================================

def export_all():
    conn = connect()
    return {
        "version": 2,
        "exported_at": time.time(),
        "circles": [dict(r) for r in conn.execute("SELECT * FROM circle")],
        "people": [dict(r) for r in conn.execute("SELECT * FROM person")],
        "memberships": [dict(r) for r in conn.execute(
            "SELECT * FROM person_circle")],
        "relations": [dict(r) for r in conn.execute("SELECT * FROM relation")],
        "events": [dict(r) for r in conn.execute("SELECT * FROM event")],
    }


def import_all(payload, replace=False):
    """从备份或演示数据恢复。同时兼容 v1(没有 circles 字段)的备份。

    人按姓名去重,关系按 (圈子,a,b,类型) 去重,所以重复导入是幂等的。
    """
    circles = payload.get("circles") or []
    people = payload.get("people", [])
    memberships = payload.get("memberships") or []
    relations = payload.get("relations", [])
    events = payload.get("events", [])

    if replace:
        with tx() as conn:
            for t in ("event_relation", "event", "relation", "person_circle",
                      "person", "circle", "layout_cache"):
                conn.execute(f"DELETE FROM {t}")

    # 圈子
    circle_map = {}
    for c in circles:
        cid = create_circle(c.get("name", ""), c.get("kind", "自定义"),
                            c.get("icon", ""), c.get("notes", ""))
        circle_map[c.get("id")] = cid
    if not circle_map:
        # v1 备份没有圈子,全部归入默认圈子
        circle_map[None] = default_circle_id()
    fallback_cid = next(iter(circle_map.values()))

    # 人
    id_map = {}
    for p in people:
        new_id, _ = upsert_person(
            p.get("name", ""), p.get("dept", ""), p.get("title", ""),
            p.get("level", 0), p.get("aliases", ""), p.get("tags", ""),
            p.get("notes", ""), bool(p.get("is_me", 0)) or None)
        id_map[p.get("id")] = new_id

    # 成员归属
    for m in memberships:
        pid = id_map.get(m.get("person_id"))
        cid = circle_map.get(m.get("circle_id"), fallback_cid)
        if pid and cid:
            add_to_circle(pid, cid, m.get("role", ""), m.get("note", ""))

    # 关系
    n_rel = 0
    for r in relations:
        a, b = id_map.get(r.get("a_id")), id_map.get(r.get("b_id"))
        cid = circle_map.get(r.get("circle_id"), fallback_cid)
        kind = normalize_kind(r.get("kind"))
        if a and b and cid and kind in RELATION_KINDS:
            upsert_relation(cid, a, b, kind, r.get("strength"),
                            r.get("notes", ""), r.get("confidence", 1.0))
            n_rel += 1

    # 事件
    n_ev = 0
    for e in events:
        old_ids = _event_people(e) if "people_json" in e else []
        new_ids = [id_map[i] for i in old_ids if i in id_map]
        cid = circle_map.get(e.get("circle_id"), fallback_cid)
        add_event(e.get("text", ""), new_ids, cid, e.get("happened_at"),
                  e.get("source", ""))
        n_ev += 1

    return {"circles": len(circle_map), "people": len(id_map),
            "relations": n_rel, "events": n_ev}
