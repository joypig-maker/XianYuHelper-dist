# -*- coding: utf-8 -*-
"""生成插件图标（纯 Python，无需第三方库）"""
import os
import struct
import zlib

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'icons')


def chunk(tag, data):
    return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)


def write_png(path, size, buf):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)
        raw += buf[y * stride:(y + 1) * stride]
    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', size, size, 8, 6, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(bytes(raw), 9))
           + chunk(b'IEND', b''))
    with open(path, 'wb') as f:
        f.write(png)


def new_buf(size):
    return bytearray(size * size * 4)


def set_px(buf, size, x, y, rgba, scale=1.0):
    x = int(x)
    y = int(y)
    if x < 0 or y < 0 or x >= size or y >= size:
        return
    i = (y * size + x) * 4
    r, g, b, a = rgba
    old_a = buf[i + 3] / 255.0
    new_a = a / 255.0
    out_a = new_a + old_a * (1 - new_a)
    if out_a <= 0:
        return
    buf[i] = int((r * new_a + buf[i] * old_a * (1 - new_a)) / out_a)
    buf[i + 1] = int((g * new_a + buf[i + 1] * old_a * (1 - new_a)) / out_a)
    buf[i + 2] = int((b * new_a + buf[i + 2] * old_a * (1 - new_a)) / out_a)
    buf[i + 3] = int(out_a * 255)


def rounded_rect(buf, size, color, radius_ratio=0.22):
    r = size * radius_ratio
    for y in range(size):
        for x in range(size):
            cx = min(max(x + 0.5, r), size - r)
            cy = min(max(y + 0.5, r), size - r)
            dx = x + 0.5 - cx
            dy = y + 0.5 - cy
            if dx * dx + dy * dy <= r * r:
                set_px(buf, size, x, y, color)


def ellipse(buf, size, cx, cy, rx, ry, color):
    for y in range(size):
        for x in range(size):
            dx = (x + 0.5 - cx) / rx
            dy = (y + 0.5 - cy) / ry
            if dx * dx + dy * dy <= 1.0:
                set_px(buf, size, x, y, color)


def triangle(buf, size, p1, p2, p3, color):
    def sign(a, b, c):
        return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])

    for y in range(size):
        for x in range(size):
            p = (x + 0.5, y + 0.5)
            d1 = sign(p1, p2, p)
            d2 = sign(p2, p3, p)
            d3 = sign(p3, p1, p)
            has_neg = (d1 < 0) or (d2 < 0) or (d3 < 0)
            has_pos = (d1 > 0) or (d2 > 0) or (d3 > 0)
            if not (has_neg and has_pos):
                set_px(buf, size, x, y, color)


def draw(size):
    s = size / 128.0
    buf = new_buf(size)
    rounded_rect(buf, size, (255, 143, 0, 255))
    white = (255, 255, 255, 255)
    # 鱼身
    ellipse(buf, size, 54 * s, 64 * s, 30 * s, 21 * s, white)
    # 尾巴
    triangle(buf, size, (82 * s, 64 * s), (110 * s, 42 * s), (110 * s, 86 * s), white)
    # 眼睛
    ellipse(buf, size, 40 * s, 57 * s, 4.5 * s, 4.5 * s, (255, 143, 0, 255))
    return buf


def main():
    os.makedirs(OUT, exist_ok=True)
    for size in (16, 32, 48, 128):
        buf = draw(size)
        path = os.path.join(OUT, 'icon-%d.png' % size)
        write_png(path, size, buf)
        print('生成', path)


if __name__ == '__main__':
    main()
