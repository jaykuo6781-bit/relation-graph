"""运行配置。

绑定地址的选择是有意为之:默认只监听 Tailscale 网卡,不监听 0.0.0.0。
数据库里是真实同事的姓名和主观评价,不应该出现在任何公网可达的端口上。
"""

import os
import socket
import ipaddress
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _load_env_file():
    """把项目根目录下的 .env 读进 os.environ。

    为什么要有这个:API Key 只能靠环境变量传进来,而在 Windows 上设一个
    持久的用户环境变量要开系统设置、还得重开终端才生效 —— 对一个双击
    run.bat 就该能用的工具来说太重了。

    **绝不要把 Key 写进 run.bat**:那个文件在版本库里,而这个仓库是公开的。
    .env 从一开始就在 .gitignore 里(连同 .env.* ),提交不上去。

    已经存在的环境变量优先 —— 临时想换个 Key 跑一次,在命令行里设一下
    就能盖过文件,不用改文件再改回来。
    """
    f = ROOT / ".env"
    try:
        raw = f.read_text(encoding="utf-8-sig")
    except (OSError, UnicodeDecodeError):
        return
    for line in raw.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, _, v = line.partition("=")
        k = k.strip()
        v = v.strip().strip('"').strip("'")     # 顺手剥掉成对的引号
        if k and k not in os.environ:
            os.environ[k] = v


_load_env_file()
DATA_DIR = ROOT / "data"
BACKUP_DIR = ROOT / "backups"
WEB_DIR = ROOT / "web"
# 允许用环境变量指向别的库 —— selftest.py 靠这个跑在临时库上,不碰真实数据
DB_PATH = Path(os.environ.get("RELGRAPH_DB", str(DATA_DIR / "graph.db")))

PORT = int(os.environ.get("RELGRAPH_PORT", "8787"))

# Tailscale 给节点分配的地址都落在 100.64.0.0/10 (CGNAT 段)
TAILSCALE_NET = ipaddress.ip_network("100.64.0.0/10")


def _outbound_ip_towards(dest):
    """查出通往 dest 会走哪块网卡的地址。

    用的是 UDP socket 的 connect —— UDP 无连接,这一步只让内核查一次路由表,
    不会真的发包,毫秒级返回。

    刻意不用 socket.getaddrinfo(socket.gethostname()):那个会触发 DNS 解析,
    在 Windows 上可能卡死几十秒,而且它在模块导入时就执行,会让整个服务
    看起来"启动了但没反应"。
    """
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.settimeout(0.5)
        s.connect((dest, 80))
        return s.getsockname()[0]
    except OSError:
        return None
    finally:
        s.close()


def detect_tailscale_ip():
    """本机的 Tailscale 地址,没装/没连就返回 None。

    100.100.100.100 是 Tailscale 的 MagicDNS 地址,只要 tailnet 在线就一定
    在路由表里,查它走哪块网卡就能拿到本机的 tailnet 地址。
    """
    addr = _outbound_ip_towards("100.100.100.100")
    if addr:
        try:
            if ipaddress.ip_address(addr) in TAILSCALE_NET:
                return addr
        except ValueError:
            pass
    return None


def detect_lan_ip():
    """本机在局域网里的地址(走默认路由的那块网卡)。"""
    addr = _outbound_ip_towards("8.8.8.8")
    if addr and not addr.startswith("127."):
        return addr
    return None


def detect_bind_host(allow_lan=False):
    """选一个监听地址。默认是安全的那个。

    优先级:
      1. RELGRAPH_HOST 环境变量(手动覆盖)
      2. Tailscale 地址 —— 最理想:手机能连,同一个 Wi-Fi 下的其他人连不上
      3. allow_lan=True 时用局域网地址 —— 同一个 Wi-Fi 下所有人都能访问
      4. 否则 127.0.0.1 —— 只有本机能用

    默认不绑局域网是刻意的:这个库里是真实同事的姓名和主观评价。
    在公司 Wi-Fi 上绑局域网地址,意味着同事可以直接打开看你怎么评价他们。
    要绑必须显式加 --lan,不能是默认行为。
    """
    override = os.environ.get("RELGRAPH_HOST")
    if override:
        return override

    ts = detect_tailscale_ip()
    if ts:
        return ts

    if allow_lan:
        lan = detect_lan_ip()
        if lan:
            return lan

    return "127.0.0.1"


# 实际监听地址在 server.py 里根据命令行参数决定(见 detect_bind_host)

# ---- 模型 (故事解析功能用,可选) ----
# 供应商相关的代码全部集中在 llm.py,换模型只改这里和那个文件
LLM_PROVIDER = os.environ.get("RELGRAPH_LLM_PROVIDER", "openai")
LLM_MODEL = os.environ.get("RELGRAPH_LLM_MODEL", "gpt-4o-mini")
LLM_API_KEY = os.environ.get("OPENAI_API_KEY", "")
LLM_BASE_URL = os.environ.get("OPENAI_BASE_URL", "")
# 单次模型请求的超时(秒)。不设的话,断网/被墙时请求能挂上几分钟,
# 前端的 busy 遮罩就一直转,用户只能强刷页面 —— 必须给它一个出口。
# 坏值(比如写成 "120s")回落默认并警告:一个可选的调优项没有资格
# 在 import 期抛异常把整个服务掀翻 —— 那个错连启动横幅都到不了。
try:
    LLM_TIMEOUT = float(os.environ.get("RELGRAPH_LLM_TIMEOUT") or 120)
except ValueError:
    print(f"⚠ RELGRAPH_LLM_TIMEOUT={os.environ.get('RELGRAPH_LLM_TIMEOUT')!r} "
          f"不是数字,已改用默认 120 秒")
    LLM_TIMEOUT = 120.0


def llm_configured():
    return bool(LLM_API_KEY)


def ensure_dirs():
    DATA_DIR.mkdir(exist_ok=True)
    BACKUP_DIR.mkdir(exist_ok=True)
