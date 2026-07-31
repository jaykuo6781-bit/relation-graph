"""HTTP 服务:静态文件 + JSON API。

用标准库 http.server 而不是 FastAPI/Flask,是刻意的取舍。这是要长期跑在
个人电脑上的私人工具,依赖越少越不会因为环境变动而烂掉 —— 双击 run.bat
就能起来,不需要 venv、不需要 pip install(除非用 AI 摄取功能)。

**文件上传走 JSON + base64,不用 multipart。** 原因有两个:
Python 3.13 删掉了 cgi 模块(以前解析 multipart 的标准做法),
而且以后要移植微信小程序时,JSON 上传的兼容性远好过 multipart。
"""

import json
import mimetypes
import posixpath
import socketserver
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

import config
import db
import importer
import layout
import analysis

# Windows 控制台默认是 cp1252,输出被重定向到文件时中文会直接抛
# UnicodeEncodeError 把服务打挂。强制走 UTF-8。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError):
        pass

MAX_BODY = 32 * 1024 * 1024      # 32MB —— 一张手机截图 base64 后大约 2~4MB

ROUTES = {}


def route(method, path):
    def deco(fn):
        ROUTES[(method, path)] = fn
        return fn
    return deco


def _cid(query, body=None, required=False):
    """从请求里取圈子 id。取不到就用默认圈子。"""
    raw = None
    if body and body.get("circle_id"):
        raw = body["circle_id"]
    elif query.get("circle"):
        raw = query["circle"][0]
    if raw in (None, "", "all"):
        return None if not required else db.default_circle_id()
    try:
        return int(raw)
    except (TypeError, ValueError):
        return db.default_circle_id() if required else None


# ============================================================
#  基础状态
# ============================================================

@route("GET", "/api/state")
def api_state(handler, query, body):
    me = db.get_me()
    conn = db.connect()
    circles = db.list_circles()
    if not circles:
        db.default_circle_id()
        circles = db.list_circles()
    return {
        "me": me,
        "circles": circles,
        "counts": {
            "people": conn.execute("SELECT COUNT(*) c FROM person").fetchone()["c"],
            "relations": conn.execute("SELECT COUNT(*) c FROM relation").fetchone()["c"],
            "events": conn.execute("SELECT COUNT(*) c FROM event").fetchone()["c"],
        },
        "kinds": {k: v for k, v in db.RELATION_KINDS.items()},
        "categories": db.RELATION_CATEGORIES,
        "category_glyph": db.CATEGORY_GLYPH,
        "circle_kinds": db.CIRCLE_KINDS,
        "llm_configured": config.llm_configured(),
        "llm_model": config.LLM_MODEL,
        "graph_version": db.graph_version(),
    }


# ============================================================
#  圈子
# ============================================================

@route("GET", "/api/circles")
def api_circles(handler, query, body):
    return {"circles": db.list_circles()}


@route("POST", "/api/circles")
def api_circle_save(handler, query, body):
    if body.get("id"):
        db.update_circle(int(body["id"]), **{
            k: v for k, v in body.items() if k != "id"})
        return {"ok": True, "id": int(body["id"])}
    cid = db.create_circle(body.get("name", ""), body.get("kind", "自定义"),
                           body.get("icon", ""), body.get("notes", ""))
    return {"ok": True, "id": cid}


@route("POST", "/api/circles/delete")
def api_circle_delete(handler, query, body):
    db.delete_circle(int(body["id"]))
    return {"ok": True}


@route("POST", "/api/circles/join")
def api_circle_join(handler, query, body):
    db.add_to_circle(int(body["person_id"]), int(body["circle_id"]),
                     body.get("role", ""))
    return {"ok": True}


@route("POST", "/api/circles/leave")
def api_circle_leave(handler, query, body):
    db.remove_from_circle(int(body["person_id"]), int(body["circle_id"]))
    return {"ok": True}


# ============================================================
#  人员
# ============================================================

@route("GET", "/api/people")
def api_people(handler, query, body):
    return {"people": db.list_people(_cid(query))}


@route("GET", "/api/person")
def api_person(handler, query, body):
    pid = int(query.get("id", [0])[0])
    cid = _cid(query)
    person = db.get_person(pid)
    if not person:
        return {"error": "找不到这个人"}
    rels = db.relations_of(pid, cid)
    # db.relations_of 不带类别信息,而人物卡要靠标记符区分「情感/利益/职场…」。
    # api_pair 一直补了这两个字段,这里漏了,于是人物卡里的 glyph 永远是空字符串。
    for r in rels:
        info = db.RELATION_KINDS.get(r["kind"], {})
        r["cat"] = info.get("cat", "社交")
        r["glyph"] = db.CATEGORY_GLYPH.get(r["cat"], "")
    return {
        "person": person,
        "circles": db.circles_of(pid),
        "relations": rels,
        "events": db.events_for_person(pid, cid),
    }


@route("POST", "/api/people")
def api_people_save(handler, query, body):
    if body.get("id"):
        db.update_person(int(body["id"]),
                         **{k: v for k, v in body.items()
                            if k not in ("id", "circle_id")})
        if body.get("circle_id"):
            db.add_to_circle(int(body["id"]), int(body["circle_id"]))
        return {"ok": True, "id": int(body["id"])}
    new_id, created = db.upsert_person(
        body.get("name", ""), body.get("dept", ""), body.get("title", ""),
        int(body.get("level", 0) or 0), body.get("aliases", ""),
        body.get("tags", ""), body.get("notes", ""),
        circle_id=_cid(query, body, required=True))
    return {"ok": True, "id": new_id, "created": created}


@route("POST", "/api/people/delete")
def api_people_delete(handler, query, body):
    db.delete_person(int(body["id"]))
    return {"ok": True}


@route("POST", "/api/people/me")
def api_set_me(handler, query, body):
    db.set_me(int(body["id"]))
    return {"ok": True, "me": db.get_me()}


# ============================================================
#  关系
# ============================================================

@route("GET", "/api/relations")
def api_relations(handler, query, body):
    return {"relations": db.list_relations_detailed(_cid(query))}


@route("POST", "/api/relations")
def api_relations_save(handler, query, body):
    rid = db.upsert_relation(
        _cid(query, body, required=True),
        int(body["a_id"]), int(body["b_id"]), body["kind"],
        body.get("strength"), body.get("notes", ""))
    return {"ok": True, "id": rid}


@route("POST", "/api/relations/delete")
def api_relations_delete(handler, query, body):
    db.delete_relation(int(body["id"]))
    return {"ok": True}


@route("GET", "/api/pair")
def api_pair(handler, query, body):
    """两个人之间的一切:全部关系 + 他俩共同出现的故事时间线。

    点击图上一条连线时调这个 —— 用户要的"人物之间的细节故事"。
    """
    a = int(query["a"][0])
    b = int(query["b"][0])
    cid = _cid(query)
    pa, pb = db.get_person(a), db.get_person(b)
    if not pa or not pb:
        return {"error": "找不到这个人"}
    rels = db.find_relations_between(a, b, cid)
    for r in rels:
        info = db.RELATION_KINDS.get(r["kind"], {})
        r["cat"] = info.get("cat", "社交")
        r["glyph"] = db.CATEGORY_GLYPH.get(r["cat"], "")
    return {
        "a": pa, "b": pb,
        "relations": rels,
        "stories": db.events_for_pair(a, b, cid),
    }


@route("POST", "/api/pair/story")
def api_pair_story(handler, query, body):
    """给某两个人之间追加一条故事。"""
    a, b = int(body["a"]), int(body["b"])
    text = (body.get("text") or "").strip()
    if not text:
        raise ValueError("内容不能为空")
    eid = db.add_event(text, [a, b], _cid(query, body, required=True),
                       body.get("happened_at"), body.get("source", "手动"))
    return {"ok": True, "id": eid}


# ============================================================
#  图谱(坐标在服务端算好)
# ============================================================

@route("GET", "/api/graph")
def api_graph(handler, query, body):
    """aspect = 视口宽/高。服务端按档位取整后决定画布形状 ——
    宽屏用宽画布、竖屏用竖画布,不再一律正方形导致两边大片空白。"""
    t0 = time.time()
    try:
        aspect = float(query.get("aspect", [0])[0])
    except (TypeError, ValueError):
        aspect = 0
    payload = layout.get_graph_payload(_cid(query), aspect)
    payload["compute_ms"] = round((time.time() - t0) * 1000, 1)
    return payload


# ============================================================
#  分析(四个功能都折叠进节点卡片,不再单独开页)
# ============================================================

@route("GET", "/api/analysis/brief")
def api_brief(handler, query, body):
    return analysis.brief(int(query.get("id", [0])[0]), _cid(query))


@route("GET", "/api/analysis/factions")
def api_factions(handler, query, body):
    cid = _cid(query)
    key = f"factions_{cid or 'all'}"
    cached = db.cache_get(key)
    if cached is None:
        cached = analysis.detect_factions(cid)
        db.cache_put(key, cached)
    return cached


@route("GET", "/api/analysis/situation")
def api_situation(handler, query, body):
    """局势页的一次性数据。刻意与上面的 api_factions 逐行同构。

    key 里不放 me_id:db.cache_get 本来就带 graph_version 校验,而 db.set_me
    也会 bump 一次 version —— 换了"我是谁"缓存自然作废。再往 key 里塞
    me_id 只会造出一堆永远命中不了的键,还得自己想清楚什么时候清。
    """
    cid = _cid(query)
    key = f"situation_{cid or 'all'}"
    cached = db.cache_get(key)
    if cached is None:
        cached = analysis.situation(cid)
        db.cache_put(key, cached)
    return cached


@route("GET", "/api/analysis/key")
def api_key_people(handler, query, body):
    return analysis.key_people(int(query.get("limit", [20])[0]), _cid(query))


@route("GET", "/api/analysis/triangles")
def api_triangles(handler, query, body):
    focus = query.get("focus", [None])[0]
    return analysis.unstable_triangles(
        limit=int(query.get("limit", [40])[0]),
        focus_id=int(focus) if focus else None,
        circle_id=_cid(query))


@route("GET", "/api/analysis/path")
def api_path(handler, query, body):
    src = query.get("from", [None])[0]
    if src is None:
        me = db.get_me()
        if not me:
            return {"error": "还没设置「我是谁」,无法计算引荐路径"}
        src = me["id"]
    return analysis.intro_path(int(src), int(query["to"][0]), _cid(query))


# ============================================================
#  批量导入
# ============================================================

@route("POST", "/api/import/roster/preview")
def api_roster_preview(handler, query, body):
    return {"rows": importer.parse_roster(body.get("text", ""))}


@route("POST", "/api/import/roster/commit")
def api_roster_commit(handler, query, body):
    return importer.commit_roster(body.get("rows", []),
                                  _cid(query, body, required=True))


@route("POST", "/api/import/relations/preview")
def api_rel_preview(handler, query, body):
    return {"rows": importer.parse_relations(
        body.get("text", ""), bool(body.get("auto_create")))}


@route("POST", "/api/import/relations/commit")
def api_rel_commit(handler, query, body):
    return importer.commit_relations(
        body.get("rows", []), _cid(query, body, required=True),
        bool(body.get("auto_create")))


# ============================================================
#  事件
# ============================================================

@route("GET", "/api/events")
def api_events(handler, query, body):
    return {"events": db.list_events(_cid(query))}


@route("POST", "/api/events")
def api_events_add(handler, query, body):
    eid = db.add_event(body.get("text", ""),
                       [int(i) for i in body.get("people", [])],
                       _cid(query, body, required=True),
                       body.get("happened_at"), body.get("source", "手动"))
    return {"ok": True, "id": eid}


@route("POST", "/api/events/delete")
def api_events_delete(handler, query, body):
    db.delete_event(int(body["id"]))
    return {"ok": True}


# ============================================================
#  AI 摄取(底部输入栏)
# ============================================================

@route("POST", "/api/ingest")
def api_ingest(handler, query, body):
    """文字 / 截图 / 文档 → 关系候选清单(等待人工审核)。

    files: [{name, mime, data(base64)}]
    """
    import llm
    try:
        return llm.ingest(
            text=body.get("text", ""),
            files=body.get("files") or [],
            circle_id=_cid(query, body, required=True))
    except llm.LLMError as e:
        return {"error": str(e)}


@route("POST", "/api/ingest/commit")
def api_ingest_commit(handler, query, body):
    import llm
    return llm.commit(body, _cid(query, body, required=True))


# ============================================================
#  备份 / 演示数据
# ============================================================

@route("GET", "/api/export")
def api_export(handler, query, body):
    payload = db.export_all()
    config.ensure_dirs()
    fname = time.strftime("backup-%Y%m%d-%H%M%S.json")
    (config.BACKUP_DIR / fname).write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    payload["_saved_to"] = str(config.BACKUP_DIR / fname)
    return payload


@route("POST", "/api/import")
def api_import(handler, query, body):
    return db.import_all(body.get("payload", {}), bool(body.get("replace")))


@route("POST", "/api/seed")
def api_seed(handler, query, body):
    """载入演示数据(全是虚构人名),用来试功能或验算法。"""
    seed_file = config.ROOT / "demo_seed.json"
    if not seed_file.exists():
        return {"error": "找不到 demo_seed.json"}
    payload = json.loads(seed_file.read_text(encoding="utf-8"))
    result = db.import_all(payload, bool(body.get("replace")))
    me_name = payload.get("me")
    if me_name:
        p = db.find_person_by_name(me_name)
        if p:
            db.set_me(p["id"])
    return result


# ============================================================
#  HTTP 处理
# ============================================================

class Handler(BaseHTTPRequestHandler):
    server_version = "relation-graph"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        sys.stderr.write("  %s\n" % (fmt % args))

    def _send(self, code, body, content_type="application/json; charset=utf-8",
              extra_headers=None):
        if isinstance(body, str):
            body = body.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj, ensure_ascii=False))

    def _static(self, url_path):
        """提供 web/ 下的静态文件。路径做了归一化,防目录穿越。"""
        rel = posixpath.normpath(url_path.lstrip("/"))
        if rel in ("", "."):
            rel = "index.html"
        if rel.startswith("..") or Path(rel).is_absolute():
            return self._send(403, "forbidden", "text/plain; charset=utf-8")

        target = (config.WEB_DIR / rel).resolve()
        try:
            target.relative_to(config.WEB_DIR.resolve())
        except ValueError:
            return self._send(403, "forbidden", "text/plain; charset=utf-8")

        if not target.is_file():
            return self._send(404, "not found", "text/plain; charset=utf-8")

        ctype, _ = mimetypes.guess_type(str(target))
        override = {".js": "application/javascript; charset=utf-8",
                    ".css": "text/css; charset=utf-8",
                    ".html": "text/html; charset=utf-8",
                    ".json": "application/json; charset=utf-8",
                    ".svg": "image/svg+xml"}
        ctype = override.get(target.suffix, ctype)
        self._send(200, target.read_bytes(), ctype or "application/octet-stream")

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        body = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
            if length > MAX_BODY:
                return self._json(
                    {"error": f"内容太大({length // 1048576}MB),"
                              f"上限 {MAX_BODY // 1048576}MB"}, 413)
            if length:
                raw = self.rfile.read(length)
                try:
                    body = json.loads(raw.decode("utf-8"))
                except (json.JSONDecodeError, UnicodeDecodeError):
                    return self._json({"error": "请求体不是合法 JSON"}, 400)

        fn = ROUTES.get((method, path))
        if fn is None:
            if method == "GET" and not path.startswith("/api/"):
                return self._static(path)
            return self._json({"error": f"没有这个接口:{method} {path}"}, 404)

        try:
            result = fn(self, query, body)
            self._json(result if result is not None else {"ok": True})
        except KeyError as e:
            # str(KeyError) 是带引号的裸键名('a_id'),直接透出去像一句黑话。
            # 键名本身就是缺的那个参数,包一层人话即可。
            self._json({"error": f"缺少参数:{e.args[0]}"}, 400)
        except ValueError as e:
            # ValueError 大多是路由里主动 raise 的中文文案("内容不能为空"),
            # 原样透出;别加前缀,加了反而把写好的句子弄拗口
            self._json({"error": str(e)}, 400)
        except Exception as e:
            traceback.print_exc()
            self._json({"error": f"服务器内部错误:{e}"}, 500)

    def do_GET(self):
        self._dispatch("GET")

    def do_POST(self):
        self._dispatch("POST")


class Server(ThreadingHTTPServer):
    """跳过 HTTPServer.server_bind() 里的 socket.getfqdn()。

    那一步会做反向 DNS 查询,在 Windows 上绑 Tailscale 地址时会卡住几十秒
    甚至永远不返回 —— 服务看起来像是"启动了但没反应"。我们并不需要 FQDN。
    """
    daemon_threads = True
    allow_reuse_address = True

    def server_bind(self):
        socketserver.TCPServer.server_bind(self)
        host, port = self.server_address[:2]
        self.server_name = str(host)
        self.server_port = port


def main():
    allow_lan = "--lan" in sys.argv
    config.ensure_dirs()
    db.connect()
    db.default_circle_id()          # 保证 UI 永远有圈子可选

    port = config.PORT
    ts_ip = config.detect_tailscale_ip()
    lan_ip = config.detect_lan_ip()

    # 同时监听两个地址:
    #   127.0.0.1  —— 这台电脑自己用,永远可用
    #   Tailscale / 局域网地址 —— 手机用
    # 刻意不绑 0.0.0.0:那会把服务暴露在所有网卡上,包括公司 Wi-Fi。
    hosts = ["127.0.0.1"]
    remote = ts_ip or (lan_ip if allow_lan else None)
    if remote and remote not in hosts:
        hosts.append(remote)

    bar = "=" * 60
    print(bar)
    print("  人际关系图谱  relation-graph")
    print(bar)

    servers, failed = [], []
    for h in hosts:
        try:
            servers.append((h, Server((h, port), Handler)))
        except OSError as e:
            failed.append((h, e))

    if not servers:
        print("  [启动失败] 没有一个地址能监听:")
        for h, e in failed:
            print(f"    {h}:{port}   {e}")
        print()
        print("  最常见的原因是端口已被占用 —— 多半是已经有一个本程序在跑了。")
        print("  查一下是谁占着:")
        print(f"      netstat -ano | findstr :{port}")
        print("  或者换个端口启动:")
        print(f"      set RELGRAPH_PORT=8788  &&  python server.py")
        print(bar, flush=True)
        return 1

    print("  可以打开的地址:")
    for h, _ in servers:
        if h == "127.0.0.1":
            note = "  ← 这台电脑上用这个"
        elif h == ts_ip:
            note = "  ← 手机上用这个(Tailscale)"
        else:
            note = "  ← 手机上用这个(局域网)"
        print(f"      http://{h}:{port}{note}")
    for h, e in failed:
        print(f"      ⚠ {h}:{port} 监听失败 —— {e}")
    print()

    if ts_ip:
        print("  手机上怎么用:")
        print("    1. iPhone 装 Tailscale,登录同一个账号")
        print(f"    2. Safari 打开 http://{ts_ip}:{port}")
        print("    3. 点底部「分享」→「添加到主屏幕」")
        print("       之后从桌面图标打开就是全屏的,跟 App 一样")
        if sys.platform == "win32":
            print()
            print("  手机打不开?多半是 Windows 防火墙拦了入站连接。")
            print("  用管理员身份打开 PowerShell,在本目录执行一次:")
            print("      .\\setup-firewall.ps1")
    elif allow_lan and lan_ip:
        print("  ⚠ 当前是局域网模式:同一个 Wi-Fi 下的任何人")
        print("    只要知道这个地址就能打开,看到你对同事的全部评价。")
        print("    在公司 Wi-Fi 上千万别开。建议改用 Tailscale:")
        print("    https://tailscale.com/download/windows")
    else:
        print("  手机现在还连不上。想在手机上用,二选一:")
        print()
        print("  【推荐】装 Tailscale(免费,两分钟)")
        print("    1. 这台电脑装:https://tailscale.com/download/windows")
        print("    2. iPhone 也装,登录同一个账号")
        print("    3. 重新运行本程序,会自动检测到并打印手机用的地址")
        print()
        print("  【临时】局域网模式:用 run-lan.bat 启动")
        if lan_ip:
            print(f"    手机连同一个 Wi-Fi,访问 http://{lan_ip}:{port}")
        print("    ⚠ 同一个 Wi-Fi 下的其他人也能访问,公司网络下不要用。")

    print()
    print("  数据库: " + str(config.DB_PATH))
    print("  按 Ctrl+C 停止")
    print(bar, flush=True)

    threads = []
    for _, srv in servers:
        t = threading.Thread(target=srv.serve_forever, daemon=True)
        t.start()
        threads.append(t)

    try:
        while any(t.is_alive() for t in threads):
            for t in threads:
                t.join(0.5)
    except KeyboardInterrupt:
        print("\n正在停止…")
    finally:
        for _, srv in servers:
            srv.shutdown()
            srv.server_close()
        print("已停止。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
