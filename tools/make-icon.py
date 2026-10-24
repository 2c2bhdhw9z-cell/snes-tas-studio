#!/usr/bin/env python3
"""Draws the app icon with no outside libraries, straight to PNG.

A dark rounded square with a pale seal-and-tick mark, which reads clearly at
home-screen size. Run from the repo root:

    python3 tools/make-icon.py
"""
import math
import struct
import zlib
from pathlib import Path

SIZE = 1024
OUT = Path("App/Signer/Resources/Assets.xcassets/AppIcon.appiconset")


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def draw():
    top = (37, 99, 235)      # blue
    bottom = (14, 23, 42)    # near-black
    mark = (240, 249, 255)   # off-white
    rows = []
    cx = cy = SIZE / 2
    ring_outer = SIZE * 0.34
    ring_inner = SIZE * 0.27

    for y in range(SIZE):
        row = bytearray()
        bg = lerp(top, bottom, y / (SIZE - 1))
        for x in range(SIZE):
            dx, dy = x - cx, y - cy
            dist = math.hypot(dx, dy)
            colour = bg

            # The seal: a ring with a soft edge.
            if ring_inner - 2 <= dist <= ring_outer + 2:
                edge = min(dist - (ring_inner - 2), (ring_outer + 2) - dist, 3) / 3
                colour = lerp(bg, mark, max(0.0, min(1.0, edge)))

            # Notches around the ring make it read as a seal rather than a circle.
            if ring_inner - 2 <= dist <= ring_outer + 2:
                angle = math.degrees(math.atan2(dy, dx)) % 30
                if angle < 7:
                    colour = bg

            # The tick inside.
            if dist < ring_inner:
                # Two strokes: short down-right, then long up-right.
                p1 = (cx - SIZE * 0.10, cy + SIZE * 0.01)
                p2 = (cx - SIZE * 0.02, cy + SIZE * 0.09)
                p3 = (cx + SIZE * 0.12, cy - SIZE * 0.10)
                width = SIZE * 0.028
                if seg_distance(x, y, p1, p2) < width or seg_distance(x, y, p2, p3) < width:
                    colour = mark

            row += bytes(colour)
        rows.append(bytes(row))
    return rows


def seg_distance(px, py, a, b):
    ax, ay = a
    bx, by = b
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    length2 = vx * vx + vy * vy
    t = 0 if length2 == 0 else max(0, min(1, (wx * vx + wy * vy) / length2))
    return math.hypot(px - (ax + t * vx), py - (ay + t * vy))


def write_png(path, rows):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", SIZE, SIZE, 8, 2, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    return len(png)


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    rows = draw()
    size = write_png(OUT / "icon-1024.png", rows)
    (OUT / "Contents.json").write_text(
        '{\n'
        '  "images" : [\n'
        '    {\n'
        '      "filename" : "icon-1024.png",\n'
        '      "idiom" : "universal",\n'
        '      "platform" : "ios",\n'
        '      "size" : "1024x1024"\n'
        '    }\n'
        '  ],\n'
        '  "info" : {\n'
        '    "author" : "xcode",\n'
        '    "version" : 1\n'
        '  }\n'
        '}\n'
    )
    (OUT.parent / "Contents.json").write_text(
        '{\n  "info" : {\n    "author" : "xcode",\n    "version" : 1\n  }\n}\n'
    )
    print(f"wrote {OUT/'icon-1024.png'} ({size} bytes)")


if __name__ == "__main__":
    main()
