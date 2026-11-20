#!/usr/bin/env python3
"""Generate crisp PNG icons (16, 48, 128) for the Resume Tailor Chrome extension."""

import os
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS_DIR = ROOT / "extension" / "icons"
ICONS_DIR.mkdir(parents=True, exist_ok=True)


def render_icon(size: int) -> Image.Image:
    # Render at 4x supersampling for crisp anti-aliased edges
    scale = 4
    s = size * scale
    img = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background rounded square (deep slate indigo)
    pad = max(2, s // 16)
    radius = s // 4
    draw.rounded_rectangle(
        [pad, pad, s - pad, s - pad],
        radius=radius,
        fill=(24, 52, 92, 255),
    )

    # Document page silhouette inside
    doc_l = int(s * 0.27)
    doc_t = int(s * 0.20)
    doc_r = int(s * 0.73)
    doc_b = int(s * 0.80)
    fold = int(s * 0.14)
    doc_radius = max(2, s // 24)

    # White document body with folded top-right corner
    doc_poly = [
        (doc_l, doc_t),
        (doc_r - fold, doc_t),
        (doc_r, doc_t + fold),
        (doc_r, doc_b),
        (doc_l, doc_b),
    ]
    draw.polygon(doc_poly, fill=(248, 250, 252, 255))

    # Folded corner accent
    fold_poly = [
        (doc_r - fold, doc_t),
        (doc_r - fold, doc_t + fold),
        (doc_r, doc_t + fold),
    ]
    draw.polygon(fold_poly, fill=(147, 197, 253, 255))

    # Resume lines inside document
    line_l = int(s * 0.34)
    line_h = max(2, int(s * 0.055))
    # Header accent bar
    draw.rounded_rectangle(
        [line_l, int(s * 0.34), int(s * 0.56), int(s * 0.34) + line_h],
        radius=max(1, line_h // 2),
        fill=(37, 99, 235, 255),
    )
    # Content lines
    for y_frac, x_end in [(0.47, 0.66), (0.58, 0.62), (0.69, 0.54)]:
        y = int(s * y_frac)
        draw.rounded_rectangle(
            [line_l, y, int(s * x_end), y + max(2, int(s * 0.045))],
            radius=max(1, int(s * 0.022)),
            fill=(100, 116, 139, 255),
        )

    # Four-point AI sparkle badge in bottom-right corner
    cx = int(s * 0.72)
    cy = int(s * 0.72)
    r_outer = int(s * 0.17)
    r_inner = int(s * 0.055)
    sparkle = [
        (cx, cy - r_outer),
        (cx + r_inner, cy - r_inner),
        (cx + r_outer, cy),
        (cx + r_inner, cy + r_inner),
        (cx, cy + r_outer),
        (cx - r_inner, cy + r_inner),
        (cx - r_outer, cy),
        (cx - r_inner, cy - r_inner),
    ]
    draw.polygon(sparkle, fill=(56, 189, 248, 255))

    return img.resize((size, size), Image.Resampling.LANCZOS)


def main() -> None:
    for size in (16, 48, 128):
        out = ICONS_DIR / f"icon-{size}.png"
        render_icon(size).save(out, format="PNG")
        print(f"Created {out} ({size}x{size})")


if __name__ == "__main__":
    main()
