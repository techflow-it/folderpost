#!/usr/bin/env python3
# SPDX-License-Identifier: GPL-3.0-or-later
# Copyright (C) 2026 TechFlow IT
"""
make-fixtures.py — creates the synthetic test PDFs in tests/fixtures/.

All pages are generated: grey bars instead of text, QR codes with made-up values.
No real documents are involved.

Requirements: Pillow (pip3 install pillow) and qrencode (brew install qrencode /
apt install qrencode). The generated files are committed, so this script is only
needed when the fixtures change.

    python3 tools/make-fixtures.py
"""
import io
import os
import random
import subprocess

from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "tests", "fixtures")
W, H = 827, 1169  # A4 at 100 dpi
random.seed(42)


def qr(value, scale=5):
    png = subprocess.run(["qrencode", "-t", "PNG", "-s", str(scale), "-m", "4", "-o", "-", value],
                         check=True, capture_output=True).stdout
    return Image.open(io.BytesIO(png)).convert("RGBA").convert("L")


def page(code=None, title_rows=3, scale=5):
    """A synthetic document page: header block, grey 'text' bars, optional QR code top right."""
    im = Image.new("L", (W, H), 255)
    d = ImageDraw.Draw(im)
    d.rectangle([60, 60, 360, 90], fill=90)
    y = 160
    for _ in range(title_rows):
        d.rectangle([60, y, 60 + random.randint(300, 650), y + 10], fill=150)
        y += 26
    y += 30
    while y < H - 120:
        d.rectangle([60, y, 60 + random.randint(400, 700), y + 8], fill=170)
        y += 22
    if code:
        q = qr(code, scale)
        im.paste(q, (W - q.width - 50, 40))
    return im


def uneven(im):
    """Unevenly blackened scan: darker left side, slight blur and noise."""
    px = im.load()
    for x in range(im.width):
        shade = int(55 * (1 - x / im.width))
        for y in range(0, im.height):
            v = px[x, y]
            if v < 128:
                v = min(255, v + int(70 * x / im.width))   # faded toner on the right
            else:
                v = max(0, v - shade)                       # grey background on the left
            px[x, y] = max(0, min(255, v + random.randint(-12, 12)))
    return im.filter(ImageFilter.GaussianBlur(0.6))


def save(name, pages, **kw):
    path = os.path.join(OUT, name)
    pages[0].save(path, save_all=True, append_images=pages[1:], resolution=100, **kw)
    print(f"{name}: {len(pages)} page(s), {os.path.getsize(path)} bytes")


def main():
    os.makedirs(OUT, exist_ok=True)
    # JPEG (DCTDecode) — the normal case for office scanners
    save("single-jpeg.pdf", [page("DOC-1001")], quality=70)
    save("batch-jpeg.pdf", [page("A-1001"), page(None), page("B-2002"), page("C-3003"), page(None)], quality=70)
    save("leading-pages-jpeg.pdf", [page(None), page("D-4004"), page(None)], quality=70)
    save("uneven-jpeg.pdf", [uneven(page("E-5005", scale=6))], quality=70)
    save("no-code-jpeg.pdf", [page(None), page(None)], quality=70)
    # CCITT Group 4 — black-and-white scans
    bw = [p.point(lambda v: 0 if v < 160 else 255).convert("1") for p in (page("F-6006"), page(None), page("G-7007"))]
    save("batch-ccitt.pdf", bw)


if __name__ == "__main__":
    main()
