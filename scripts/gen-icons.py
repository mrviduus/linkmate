#!/usr/bin/env python3
"""Generate LinkMate icon PNGs at 16/32/64/128 px.

Solid LinkedIn blue background, lowercase 'lm' in white, centered.
Run from repo root: python3 scripts/gen-icons.py
"""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "src" / "icons"
BG = (10, 102, 194, 255)  # #0a66c2 LinkedIn blue
FG = (255, 255, 255, 255)
SIZES = [16, 32, 64, 128]
TEXT = "lm"

# Try a few common bold sans fonts; fall back to PIL default if none found.
FONT_CANDIDATES = [
    "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
    "/System/Library/Fonts/Helvetica.ttc",
    "/Library/Fonts/Arial Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for path in FONT_CANDIDATES:
        try:
            return ImageFont.truetype(path, size)
        except (OSError, IOError):
            continue
    return ImageFont.load_default()


def make(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), BG)
    draw = ImageDraw.Draw(img)
    # Sweep down font size until text fits ~70% width.
    target_w = size * 0.72
    fsize = size
    while fsize > 4:
        font = load_font(fsize)
        bbox = draw.textbbox((0, 0), TEXT, font=font)
        w = bbox[2] - bbox[0]
        h = bbox[3] - bbox[1]
        if w <= target_w and h <= size * 0.8:
            break
        fsize -= 1
    bbox = draw.textbbox((0, 0), TEXT, font=font)
    tw = bbox[2] - bbox[0]
    th = bbox[3] - bbox[1]
    # Center, accounting for text bbox origin offset.
    x = (size - tw) / 2 - bbox[0]
    y = (size - th) / 2 - bbox[1]
    draw.text((x, y), TEXT, fill=FG, font=font)
    return img


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for s in SIZES:
        img = make(s)
        path = OUT / f"icon-{s}.png"
        img.save(path)
        print(f"wrote {path} ({s}x{s})")


if __name__ == "__main__":
    main()
