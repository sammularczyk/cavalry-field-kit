#!/usr/bin/env python3
"""Placeholder filter icons: black initials on the native Effects pink.

Four PNGs per filter - 18, 36 (@2x), 16 (_ae) and 32 (_ae@2x). Only the 18px
file is named in the definition's UI.icon; Cavalry finds the rest by suffix.

Pure stdlib on purpose: zlib and struct are all a PNG needs, and the repo has
no build step to hang a dependency off.
"""
import json, os, struct, zlib

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLUGIN = os.path.join(HERE, "Field Kit")

BG = (0xF5, 0xB4, 0xB8, 255)      # documented native colour for Effects
FG = (0, 0, 0, 255)

INITIALS = {
    "ascii": "AS", "compositeVideo": "CV", "display": "DS",
    "film": "FM", "glow": "GL", "hatching": "HT", "led": "LE", "lens": "LN",
    "lightwrap": "LW", "paint": "PT", "photocopy": "PC",
    "polarCoordinates": "PO", "vhs": "VH",
    "print": "PR", "lightLeak": "LL", "filmBurn": "FB",
    "lensFlare": "LF", "godray": "GR",
}

FONT = {
 "A": "01110 10001 10001 11111 10001 10001 10001",
 "B": "11110 10001 10001 11110 10001 10001 11110",
 "C": "01110 10001 10000 10000 10000 10001 01110",
 "D": "11110 10001 10001 10001 10001 10001 11110",
 "E": "11111 10000 10000 11110 10000 10000 11111",
 "F": "11111 10000 10000 11110 10000 10000 10000",
 "G": "01110 10001 10000 10111 10001 10001 01111",
 "H": "10001 10001 10001 11111 10001 10001 10001",
 "L": "10000 10000 10000 10000 10000 10000 11111",
 "M": "10001 11011 10101 10101 10001 10001 10001",
 "N": "10001 11001 10101 10101 10011 10001 10001",
 "O": "01110 10001 10001 10001 10001 10001 01110",
 "P": "11110 10001 10001 11110 10000 10000 10000",
 "R": "11110 10001 10001 11110 10100 10010 10001",
 "S": "01111 10000 10000 01110 00001 00001 11110",
 "T": "11111 00100 00100 00100 00100 00100 00100",
 "V": "10001 10001 10001 10001 10001 01010 00100",
 "W": "10001 10001 10001 10101 10101 11011 10001",
}
GW, GH = 5, 7


def write_png(path, size, px):
    raw = b"".join(b"\x00" + bytes(v for x in range(size) for v in px[y][x])
                   for y in range(size))
    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c))
    png = (b"\x89PNG\r\n\x1a\n"
           + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
           + chunk(b"IDAT", zlib.compress(raw, 9))
           + chunk(b"IEND", b""))
    open(path, "wb").write(png)


def icon(size, initials):
    px = [[(0, 0, 0, 0)] * size for _ in range(size)]
    r = max(2.0, size * 0.22)
    for y in range(size):
        for x in range(size):
            # rounded-rect coverage, sampled 2x2 for a soft edge
            cov = 0
            for sy in (0.25, 0.75):
                for sx in (0.25, 0.75):
                    dx = max(r - (x + sx), (x + sx) - (size - r), 0.0)
                    dy = max(r - (y + sy), (y + sy) - (size - r), 0.0)
                    if dx * dx + dy * dy <= r * r:
                        cov += 1
            if cov:
                a = int(BG[3] * cov / 4)
                px[y][x] = (BG[0], BG[1], BG[2], a)

    n = len(initials)
    tw, th = n * GW + (n - 1), GH
    scale = max(1, min(size // (tw + 2), size // (th + 2)))
    ox = (size - tw * scale) // 2
    oy = (size - th * scale) // 2
    for i, ch in enumerate(initials):
        rows = FONT[ch].split()
        for gy, row in enumerate(rows):
            for gx, bit in enumerate(row):
                if bit != "1":
                    continue
                bx = ox + (i * (GW + 1) + gx) * scale
                by = oy + gy * scale
                for dy in range(scale):
                    for dx in range(scale):
                        X, Y = bx + dx, by + dy
                        if 0 <= X < size and 0 <= Y < size:
                            px[Y][X] = FG
    return px


def main():
    made = 0
    for t, ini in sorted(INITIALS.items()):
        for suffix, size in (("", 18), ("@2x", 36), ("_ae", 16), ("_ae@2x", 32)):
            write_png(os.path.join(PLUGIN, f"{t}{suffix}.png"), size, icon(size, ini))
            made += 1
    print(f"{made} icons written to {PLUGIN}")


if __name__ == "__main__":
    main()
