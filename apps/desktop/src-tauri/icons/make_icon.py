#!/usr/bin/env python3
"""Generates the 512x512 SeekForge icon source (dark square, "SF" glyphs).

Pure-stdlib PNG writer so it works without Pillow. Re-run with:
    python3 apps/desktop/src-tauri/icons/make_icon.py
then regenerate the platform icons with:
    pnpm tauri icon apps/desktop/src-tauri/icons/icon-source.png
"""
import os
import struct
import zlib

SIZE = 512
BG = (24, 26, 32, 255)        # dark slate
FG = (122, 219, 180, 255)     # mint accent

# 5x7 blocky glyphs.
GLYPHS = {
    "S": [
        "01111",
        "10000",
        "10000",
        "01110",
        "00001",
        "00001",
        "11110",
    ],
    "F": [
        "11111",
        "10000",
        "10000",
        "11110",
        "10000",
        "10000",
        "10000",
    ],
}


def render():
    px = [[BG for _ in range(SIZE)] for _ in range(SIZE)]
    scale = 40  # each glyph cell is 40px -> glyph 200x280
    gap = 24
    text_w = 2 * 5 * scale + gap
    text_h = 7 * scale
    x0 = (SIZE - text_w) // 2
    y0 = (SIZE - text_h) // 2
    for i, ch in enumerate("SF"):
        ox = x0 + i * (5 * scale + gap)
        for r, row in enumerate(GLYPHS[ch]):
            for c, bit in enumerate(row):
                if bit == "1":
                    for y in range(y0 + r * scale, y0 + (r + 1) * scale):
                        for x in range(ox + c * scale, ox + (c + 1) * scale):
                            px[y][x] = FG
    return px


def write_png(path, px):
    raw = b"".join(
        b"\x00" + b"".join(struct.pack("4B", *p) for p in row) for row in px
    )

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", SIZE, SIZE, 8, 6, 0, 0, 0)
    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", ihdr))
        f.write(chunk(b"IDAT", zlib.compress(raw, 9)))
        f.write(chunk(b"IEND", b""))


if __name__ == "__main__":
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), "icon-source.png")
    write_png(out, render())
    print(out)
