"""HTTP 服务:静态文件 + JSON API。

用标准库 http.server 而不是 FastAPI/Flask,是刻意的取舍。这是要长期跑在
个人电脑上的私人工具,依赖越少越不会因为环境变动而烂掉 —— 双击 run.bat
就能起来,不需要 venv、不需要 pip install(除非用故事解析功能)。
单用户、百来号人的规模,标准库完全够。
"""

import json
import mimetypes
import posixpath
import socketserver
import sys
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

ROUTES = {}


def route(method, path):
    def deco(fn):
        ROUTES[(method, path)] = fn
        return fn
    return deco


# ============================================================
#  基础状态
# ============================================================

@route("GET", "/api/state")
def api_state(handler, query, body):
    me = db.get_me()
    conn = db.connect()
    n_people = conn.execute("SELECT COUNT(*) c FROM person").fetchone()["c"]
    n_rel = conn.execute("SELECT COUNT(*) c FROM relation").fetchone()["c"]
    n_ev = conn.execute("SELECT COUNT(*) c FROM event").fetchone()["c"]
    return {
        "me": me,
        "counts": {"people": n_people, "relations": n_rel, "events": n_ev},
        "kinds": db.RELATION_KINDS,
        "directed_kinds": sorted(db.DIRECTED_KINDS),
        "llm_configured": config.llm_configured(),
        "llm_model": config.LLM_MODEL,
        "graph_version": db.graph_version(),
    }


# ============================================================
#  人员
# ============================================================

@route("GET", "/api/people")
def api_people(handler, query, body):
    return {"people": db.list_people()}


@route("GET", "/api/person")
def api_person(handler, query, body):
    pid = int(query.get("id", [0])[0])
    person = db.get_person(pid)
    if not person:
        return {"error": "找不到这个人"}
    return {
        "person": person,
        "relations": db.relations_of(pid),
        "events": db.events_for_person(pid),
    }


@route("POST", "/api/people")
def api_people_save(handler, query, body):
    pid = body.get("id")
    if pid:
        db.update_person(int(pid), **{k: v for k, v in body.items()
                                      if k != "id"})
        return {"ok": True, "id": int(pid)}
    new_id, created = db.upsert_person(
        body.get("name", ""), body.get("dept", ""), body.get("title", ""),
        int(body.get("level", 0) or 0), body.get("aliases", ""),
        body.get("tags", ""), body.get("notes", ""))
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
    return {"relations": db.list_relations_detailed()}


@route("POST", "/api/relations")
def api_relations_save(handler, query, body):
    rid = db.upsert_relation(
        int(body["a_id"]), int(body["b_id"]), body["kind"],
        int(body.get("strength", 0) or 0), body.get("notes", ""))
    return {"ok": True, "id": rid}


@route("POST", "/api/relations/delete")
def api_relations_delete(handler, query, body):
    db.delete_relation(int(body["id"]))
    return {"ok": True}


# ============================================================
#  图谱(坐标在服务端算好)
# ============================================================

@route("GET", "/api/graph")
def api_graph(handler, query, body):
    t0 = time.time()
    payload = layout.get_graph_payload()
    payload["compute_ms"] = round((time.time() - t0) * 1000, 1)
    return payload


# ============================================================
#  分析
# ============================================================

@route("GET", "/api/analysis/brief")
def api_brief(handler, query, body):
    return analysis.brief(int(query.get("id", [0])[0]))


@route("GET", "/api/analysis/allies")
def api_allies(handler, query, body):
    me = db.get_me()
    return analysis.enemies_of_enemy(
        int(query.get("id", [0])[0]), me["id"] if me else None)


@route("GET", "/api/analysis/factions")
def api_factions(handler, query, body):
    cached = db.cache_get("factions")
    if cached is None:
        cached = analysis.detect_factions()
        db.cache_put("factions", cached)
    return cached


@route("GET", "/api/analysis/key")
def api_key_people(handler, query, body):
    return analysis.key_people(limit=int(query.get("limit", [20])[0]))


@route("GET", "/api/analysis/triangles")
def api_triangles(handler, query, body):
    focus = query.get("focus", [None])[0]
    return analysis.unstable_triangles(
        limit=int(query.get("limit", [40])[0]),
        focus_id=int(focus) if focus else None)


@route("GET", "/api/analysis/path")
def api_path(handler, query, body):
    src = query.get("from", [None])[0]
    if src is None:
        me = db.get_me()
        if not me:
            return {"error": "还没设置「我是谁」,无法计算引荐路径"}
        src = me["id"]
    return analysis.intro_path(int(src), int(query["to"][0]))


# ============================================================
#  批量导入
# ============================================================

@route("POST", "/api/import/roster/preview")
def api_roster_preview(handler, query, body):
    return {"rows": importer.parse_roster(body.get("text", ""))}


@route("POST", "/api/import/roster/commit")
def api_roster_commit(handler, query, body):
    return importer.commit_roster(body.get("rows", []))


@route("POST", "/api/import/relations/preview")
def api_rel_preview(handler, query, body):
    return {"rows": importer.parse_relations(
        body.get("text", ""), bool(body.get("auto_create")))}


@route("POST", "/api/import/relations/commit")
def api_rel_commit(handler, query, body):
    return importer.commit_relations(
        body.get("rows", []), bool(body.get("auto_create")))


# ============================================================
#  事件
# ============================================================

@route("GET", "/api/events")
def api_events(handler, query, body):
    return {"events": db.list_events()}


@route("POST", "/api/events")
def api_events_add(handler, query, body):
    eid = db.add_event(body.get("text", ""),
                       [int(i) for i in body.get("people", [])],
                       body.get("happened_at"))
    # 顺手按事件调整关系强度
    for adj in body.get("adjust", []):
        try:
            rid = db.upsert_relation(
                int(adj["a_id"]), int(adj["b_id"]), adj["kind"],
                int(adj.get("strength", 0)), notes=body.get("text", "")[:200])
            db.link_event_relation(eid, rid, int(adj.get("strength", 0)))
        except (KeyError, ValueError):
            continue
    return {"ok": True, "id": eid}


@route("POST", "/api/events/delete")
def api_events_delete(handler, query, body):
    db.delete_event(int(body["id"]))
    return {"ok": True}


# ============================================================
#  模型故事解析
# ============================================================

@route("POST", "/api/llm/parse")
def api_llm_parse(handler, query, body):
    import llm
    try:
        return llm.parse_story(body.get("text", ""))
    except llm.LLMError as e:
        return {"error": str(e)}


@route("POST", "/api/llm/commit")
def api_llm_commit(handler, query, body):
    import llm
    return llm.commit(body)


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

    # ---- 工具 ----
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
        if target.suffix == ".js":
            ctype = "application/javascript; charset=utf-8"
        elif target.suffix == ".css":
            ctype = "text/css; charset=utf-8"
        elif target.suffix == ".html":
            ctype = "text/html; charset=utf-8"
        elif target.suffix == ".json":
            ctype = "application/json; charset=utf-8"
        self._send(200, target.read_bytes(), ctype or "application/octet-stream")

    def _dispatch(self, method):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)

        body = {}
        if method == "POST":
            length = int(self.headers.get("Content-Length") or 0)
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
        except (ValueError, KeyError) as e:
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

    port = config.PORT
    host = config.detect_bind_host(allow_lan=allow_lan)
    ts_ip = config.detect_tailscale_ip()
    lan_ip = config.detect_lan_ip()

    bar = "=" * 60
    print(bar)
    print("  人际关系图谱  relation-graph")
    print(bar)
    print(f"  本机访问:  http://127.0.0.1:{port}")
    print()

    if ts_ip:
        print(f"  手机访问:  http://{ts_ip}:{port}   (Tailscale,推荐)")
        print()
        print("  手机上怎么用:")
        print("    1. iPhone 装 Tailscale,登录同一个账号")
        print(f"    2. Safari 打开 http://{ts_ip}:{port}")
        print("    3. 点底部「分享」→「添加到主屏幕」")
        print("       之后从桌面图标打开就是全屏的,跟 App 一样")
    elif allow_lan and lan_ip:
        print(f"  手机访问:  http://{lan_ip}:{port}   (局域网)")
        print()
        print("  ⚠ 当前是局域网模式:同一个 Wi-Fi 下的任何人")
        print("    只要知道这个地址就能打开,看到你对同事的全部评价。")
        print("    在公司 Wi-Fi 上千万别开。建议改用 Tailscale:")
        print("    https://tailscale.com/download/windows")
        print()
        print("  手机上:同一个 Wi-Fi → Safari 打开上面的地址")
        print("        → 分享 →「添加到主屏幕」")
    else:
        print("  目前只有这台电脑能访问。想在手机上用,二选一:")
        print()
        print("  【推荐】装 Tailscale(免费,两分钟)")
        print("    1. 这台电脑装:https://tailscale.com/download/windows")
        print("    2. iPhone 也装,登录同一个账号")
        print("    3. 重新运行本程序,会自动检测到并打印手机用的地址")
        print("    好处:只有你自己的设备能连,在外面用手机流量也能连。")
        print()
        print("  【临时】局域网模式:用 run-lan.bat 启动")
        if lan_ip:
            print(f"    手机连同一个 Wi-Fi,访问 http://{lan_ip}:{port}")
        print("    ⚠ 同一个 Wi-Fi 下的其他人也能访问,公司网络下不要用。")

    print()
    print("  数据库: " + str(config.DB_PATH))
    print("  按 Ctrl+C 停止")
    print(bar, flush=True)

    httpd = Server((host, port), Handler)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止。")
        httpd.server_close()


if __name__ == "__main__":
    main()
