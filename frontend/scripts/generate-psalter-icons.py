#!/usr/bin/env python3
"""Draw the Psalter app icon and write the sizes the manifest asks for.

The mark is a Byzantine mosaic halo that doubles as a record: concentric
courses of gold tesserae for grooves, the red and cream rim of a halo for the
record's edge, and a dark head-and-shoulders silhouette whose head sits where
the label would be.

Run from the repo root:  python3 frontend/scripts/generate-psalter-icons.py
Requires Pillow. Regenerate only when the artwork changes; the PNGs are
committed so a normal build needs nothing.
"""

import math
import random
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "public" / "icons"
SS = 4  # supersample, then downsample for clean edges

GOLD = (198, 160, 66)
GOLD_LIGHT = (226, 193, 104)
RED = (158, 44, 40)
CREAM = (238, 231, 212)
GROUT = (96, 84, 58)
FIGURE = (24, 28, 50, 255)
GROUND = (46, 54, 96, 255)

# Chosen by eye at 48px as well as full size: any finer and the mosaic blurs
# into a gradient when small, any coarser and it reads as stained glass.
TESSERA = 0.036
RADIUS = 0.395
LABEL_FRAC = 0.32
BODY_W = 0.58
SEED = 3


def _jitter(colour, amount, rnd):
    return tuple(max(0, min(255, colour[i] + rnd.randint(-amount, amount))) for i in range(3)) + (255,)


def _course(draw, cx, cy, radius, tess, colour, amount, rnd):
    """One ring of tesserae laid along the circle, as mosaic andamento does."""
    count = max(8, int(2 * math.pi * radius / tess))
    for i in range(count):
        a = 2 * math.pi * i / count
        x, y = cx + math.cos(a) * radius, cy + math.sin(a) * radius
        half = tess * 0.42
        ca, sa = math.cos(a), math.sin(a)
        draw.polygon(
            [
                (x - half * ca + half * sa, y - half * sa - half * ca),
                (x + half * ca + half * sa, y + half * sa - half * ca),
                (x + half * ca - half * sa, y + half * sa + half * ca),
                (x - half * ca - half * sa, y - half * sa + half * ca),
            ],
            fill=_jitter(colour, amount, rnd),
        )


def render(size, scale=1.0, ground=GROUND, rounded=True):
    """One icon. `scale` shrinks the mark for the maskable safe zone."""
    rnd = random.Random(SEED)
    S = size * SS
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    if rounded:
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.22), fill=255)
    else:
        ImageDraw.Draw(mask).rectangle([0, 0, S - 1, S - 1], fill=255)
    img.paste(Image.new("RGBA", (S, S), ground), (0, 0), mask)

    draw = ImageDraw.Draw(img)
    c = S / 2
    R = S * RADIUS * scale
    cy = c - S * 0.045 * scale
    tess = S * TESSERA * scale

    # halo, laid outside in
    draw.ellipse([c - R, cy - R, c + R, cy + R], fill=GROUT + (255,))
    r, band = R - tess * 0.6, 0
    while r > R * LABEL_FRAC:
        _course(draw, c, cy, r, tess, GOLD if band % 2 else GOLD_LIGHT, 16, rnd)
        r -= tess * 0.94
        band += 1
    _course(draw, c, cy, R - tess * 0.1, tess, RED, 10, rnd)
    _course(draw, c, cy, R - tess * 1.05, tess, CREAM, 10, rnd)

    # head, which is also the record's label, then shoulders
    layer = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    ld = ImageDraw.Draw(layer)
    hr = R * LABEL_FRAC
    ld.ellipse([c - hr, cy - hr * 1.08, c + hr, cy + hr * 1.08], fill=FIGURE)
    bw = R * BODY_W
    top = cy + hr * 1.22
    ld.rounded_rectangle([c - bw, top, c + bw, top + R * 1.02], radius=R * 0.30, fill=FIGURE)
    img.alpha_composite(layer)

    if rounded:
        out = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        out.paste(img, (0, 0), mask)
        img = out
    return img.resize((size, size), Image.LANCZOS)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for size in (180, 192, 512):
        render(size).save(OUT / f"psalter-{size}.png")
    # Maskable: full bleed, mark inside the middle 80% so a circular crop is safe.
    render(512, scale=0.80, rounded=False).save(OUT / "psalter-512-maskable.png")
    render(1024).save(OUT / "psalter-1024.png")
    print(f"wrote 5 icons to {OUT}")


if __name__ == "__main__":
    main()
