"""Build the two white cards shown in the Grafana dashboard banner (used by 21-grafana.py).

    python make-grafana-cards.py

  grafana-iot-card.png      brand card of the fictional demo company (Contoso Mining)
  grafana-powered-card.png  "Powered by Azure Event Grid and Event Hubs"
Cards are drawn at 2x so they stay sharp on high-DPI screens; 21-grafana.py shows them at half size.
White cards stay readable on Grafana's dark and light themes. Replace the brand card with your own logo
if you like (keep the height: 48 px shown, 96 px drawn).
"""
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

HERE = Path(__file__).resolve().parent

S = 2                      # drawing scale (2x)
CARD_H = 48 * S            # card height shown in Grafana: 48 px
PAD_X = 14 * S
RADIUS = 8 * S
BORDER = (221, 227, 234, 255)
INK = (34, 48, 63, 255)
GREY = (91, 102, 115, 255)       # same colours as the operator-app header
BLUE = (15, 108, 189, 255)


def font(names, size):
    for name in names:
        for folder in (Path(r"C:\Windows\Fonts"), Path("/usr/share/fonts/truetype/dejavu")):
            if (folder / name).exists():
                return ImageFont.truetype(str(folder / name), size)
    return ImageFont.load_default(size)


REGULAR = ["segoeui.ttf", "DejaVuSans.ttf"]
SEMIBOLD = ["seguisb.ttf", "DejaVuSans-Bold.ttf"]
BOLD = ["segoeuib.ttf", "DejaVuSans-Bold.ttf"]


def card(width):
    """White rounded card with a 1 px border, anti-aliased by drawing at 4x and scaling down."""
    k = 4
    big = Image.new("RGBA", (width * k, CARD_H * k), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle([0, 0, width * k - 1, CARD_H * k - 1], radius=RADIUS * k, fill=BORDER)
    d.rounded_rectangle([S * k, S * k, width * k - 1 - S * k, CARD_H * k - 1 - S * k],
                        radius=(RADIUS - S) * k, fill=(255, 255, 255, 255))
    return big.resize((width, CARD_H), Image.LANCZOS)


def hexagon(d, cx, cy, r, fill):
    pts = [(cx, cy - r), (cx + 0.866 * r, cy - r / 2), (cx + 0.866 * r, cy + r / 2),
           (cx, cy + r), (cx - 0.866 * r, cy + r / 2), (cx - 0.866 * r, cy - r / 2)]
    d.polygon(pts, fill=fill)


def brand_card():
    name, tag = font(BOLD, 17 * S), font(REGULAR, 10 * S)
    mark = 30 * S
    text_w = max(round(name.getlength("CONTOSO")), round(tag.getlength("MINING  ·  DEMO")))
    c = card(PAD_X + mark + 10 * S + text_w + PAD_X)
    d = ImageDraw.Draw(c)
    cx, cy = PAD_X + mark // 2, CARD_H // 2
    hexagon(d, cx, cy, mark // 2, BLUE)
    hexagon(d, cx, cy, round(mark * 0.3), (255, 255, 255, 230))
    d.ellipse([cx - 3 * S, cy - 3 * S, cx + 3 * S, cy + 3 * S], fill=BLUE)
    x = PAD_X + mark + 10 * S
    d.text((x, cy - 1 * S), "CONTOSO", font=name, fill=INK, anchor="ls")
    d.text((x + S, cy + 12 * S), "MINING  ·  DEMO", font=tag, fill=GREY, anchor="ls")
    return c


def powered_card():
    regular, semibold = font(REGULAR, 13 * S), font(SEMIBOLD, 13 * S)
    parts = [("Powered by ", regular, GREY), ("Azure Event Grid", semibold, BLUE),
             (" and ", regular, GREY), ("Event Hubs", semibold, BLUE)]
    text_w = sum(round(f.getlength(t)) for t, f, _ in parts)
    c = card(PAD_X + text_w + PAD_X)
    d = ImageDraw.Draw(c)
    x, mid = PAD_X, CARD_H // 2
    for t, f, col in parts:
        d.text((x, mid), t, font=f, fill=col, anchor="lm")
        x += round(f.getlength(t))
    return c


if __name__ == "__main__":
    for name, im in (("grafana-iot-card.png", brand_card()), ("grafana-powered-card.png", powered_card())):
        im.save(HERE / name, optimize=True)
        print(f"{name}: {im.width}x{im.height} px (shown at {im.width // S}x{im.height // S}), "
              f"{(HERE / name).stat().st_size} bytes")
