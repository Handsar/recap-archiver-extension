# -*- coding: utf-8 -*-
"""Generate the extension icons with the Python standard library only."""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(__file__), '..', 'icons')
BG = (14, 122, 108, 255)
PAPER = (246, 250, 249, 255)
LINE = (14, 122, 108, 255)
ORANGE = (224, 138, 46, 255)
WHITE = (255, 255, 255, 255)


def blank(size):
    return [[(0, 0, 0, 0) for _ in range(size)] for _ in range(size)]


def put(px, x, y, color):
    s = len(px)
    xi, yi = int(x), int(y)
    if 0 <= xi < s and 0 <= yi < s:
        px[yi][xi] = color


def rect(px, x0, y0, x1, y1, color):
    for y in range(int(y0), int(y1) + 1):
        for x in range(int(x0), int(x1) + 1):
            put(px, x, y, color)


def rounded(px, x0, y0, x1, y1, r, color):
    for y in range(int(y0), int(y1) + 1):
        for x in range(int(x0), int(x1) + 1):
            cx = min(max(x, x0 + r), x1 - r)
            cy = min(max(y, y0 + r), y1 - r)
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 1:
                put(px, x, y, color)


def disc(px, cx, cy, r, color):
    for y in range(int(cy - r), int(cy + r) + 1):
        for x in range(int(cx - r), int(cx + r) + 1):
            if (x - cx) ** 2 + (y - cy) ** 2 <= r * r:
                put(px, x, y, color)


def write_png(path, px):
    size = len(px)
    raw = bytearray()
    for row in px:
        raw.append(0)
        for r, g, b, a in row:
            raw += bytes((r, g, b, a))

    def chunk(tag, data):
        return (struct.pack('>I', len(data)) + tag + data +
                struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF))

    ihdr = struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0)
    png = (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) +
           chunk(b'IDAT', zlib.compress(bytes(raw), 9)) + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def build(size):
    px = blank(size)
    s = float(size)
    rounded(px, 0, 0, s - 1, s - 1, s * 0.22, BG)
    # document sheet
    rounded(px, s * .24, s * .16, s * .70, s * .84, s * .055, PAPER)
    for i, y in enumerate((.32, .44, .56)):
        w = (.30, .26, .22)[i]
        rect(px, s * .32, s * y, s * (.32 + w), s * (y + .035), LINE)
    # download badge
    cx, cy, r = s * .74, s * .74, s * .20
    disc(px, cx, cy, r, ORANGE)
    rect(px, cx - s * .025, cy - s * .095, cx + s * .025, cy + s * .035, WHITE)
    for k in range(int(s * .09)):
        half = s * .085 - k
        rect(px, cx - half, cy + s * .025 + k, cx + half, cy + s * .025 + k + 1, WHITE)
    return px


def main():
    os.makedirs(OUT, exist_ok=True)
    for n in (16, 48, 128):
        p = os.path.join(OUT, 'icon%d.png' % n)
        write_png(os.path.abspath(p), build(n))
        print('generated', p, os.path.getsize(p), 'bytes')


if __name__ == '__main__':
    main()
