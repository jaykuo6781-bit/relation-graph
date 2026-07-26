"""生成 PWA 图标 PNG。

iOS 的 apple-touch-icon 只认 PNG(不支持 SVG),所以需要这一步。
图案跟 web/icon.svg 一致:一个小的关系图 —— 实线是正向关系,虚线是负向。

跑法:  python make_icons.py     (需要 Pillow;Anaconda 自带)
只在图标需要改动时跑,产物已提交到仓库。
"""

from pathlib import Path

try:
    from PIL import Image, ImageDraw
except ImportError:
    raise SystemExit("需要 Pillow:pip install pillow")

WEB = Path(__file__).resolve().parent / "web"

BG = (20, 22, 26, 255)
BLUE = (57, 135, 229, 255)
ORANGE = (217, 89, 38, 255)
GREEN = (25, 158, 112, 255)
GRAY = (118, 125, 140, 255)
RED = (230, 103, 103, 255)

NODES = [((160, 180), 44, BLUE), ((352, 150), 34, ORANGE),
         ((196, 360), 38, GREEN), ((360, 372), 26, GRAY)]
SOLID = [((160, 180), (352, 150)), ((160, 180), (196, 360)),
         ((196, 360), (360, 372))]
DASHED = [((352, 150), (196, 360))]


def dashed_line(draw, p0, p1, color, width, dash=26, gap=18):
    (x0, y0), (x1, y1) = p0, p1
    total = ((x1 - x0) ** 2 + (y1 - y0) ** 2) ** 0.5
    if total == 0:
        return
    ux, uy = (x1 - x0) / total, (y1 - y0) / total
    pos = 0.0
    while pos < total:
        end = min(pos + dash, total)
        draw.line([(x0 + ux * pos, y0 + uy * pos),
                   (x0 + ux * end, y0 + uy * end)], fill=color, width=width)
        pos = end + gap


def build(size):
    ss = 4                                   # 超采样,边缘更干净
    n = 512 * ss
    img = Image.new("RGBA", (n, n), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    r = 112 * ss
    d.rounded_rectangle([0, 0, n - 1, n - 1], radius=r, fill=BG)

    for a, b in SOLID:
        d.line([(a[0] * ss, a[1] * ss), (b[0] * ss, b[1] * ss)],
               fill=BLUE, width=14 * ss)
    for a, b in DASHED:
        dashed_line(d, (a[0] * ss, a[1] * ss), (b[0] * ss, b[1] * ss),
                    RED, 14 * ss, 26 * ss, 18 * ss)
    for (cx, cy), rad, color in NODES:
        d.ellipse([(cx - rad) * ss, (cy - rad) * ss,
                   (cx + rad) * ss, (cy + rad) * ss], fill=color)

    return img.resize((size, size), Image.LANCZOS)


def main():
    WEB.mkdir(exist_ok=True)
    for size in (180, 192, 512):
        out = WEB / f"icon-{size}.png"
        build(size).save(out)
        print(f"  写入 {out.name}")


if __name__ == "__main__":
    main()
