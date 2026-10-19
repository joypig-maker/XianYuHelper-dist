# -*- coding: utf-8 -*-
"""对比本地与 CDN 两份 crx：大小、manifest 内容、zip 内各文件哈希。"""
import hashlib
import io
import json
import struct
import sys
import zipfile

pairs = [
    ('本地 hosting', sys.argv[1] if len(sys.argv) > 1 else 'dist/release/hosting/XianYuHelper.crx'),
    ('CDN jsDelivr', sys.argv[2] if len(sys.argv) > 2 else 'dist/_cdn_check.crx'),
]


def load(path):
    # CRX3 = magic(4) + version(4) + header_len(4) + header(protobuf) + zip
    d = open(path, 'rb').read()
    ver = struct.unpack('<I', d[4:8])[0]
    hl = struct.unpack('<I', d[8:12])[0]
    payload = d[12 + hl:]
    assert payload[:2] == b'PK', 'zip 起点解析错误: %r' % payload[:4]
    z = zipfile.ZipFile(io.BytesIO(payload))
    return d, ver, hl, z


summary = {}
for label, path in pairs:
    d, ver, hl, z = load(path)
    m = json.loads(z.read('manifest.json'))
    print('%s  %s' % (label, path))
    print('   文件大小  : %d 字节' % len(d))
    print('   CRX 版本  : %d' % ver)
    print('   manifest  : version=%s name=%s' % (m.get('version'), m.get('name')))
    print('   zip 内文件: %s' % ', '.join(z.namelist()[:6]))
    summary[label] = {n: hashlib.sha256(z.read(n)).hexdigest()[:16] for n in z.namelist()}

print('-' * 60)
keys = sorted(set(summary['本地 hosting']) | set(summary['CDN jsDelivr']))
same = True
for k in keys:
    a = summary['本地 hosting'].get(k)
    b = summary['CDN jsDelivr'].get(k)
    ok = a == b
    same = same and ok
    print('  %-24s 本地=%s  CDN=%s  %s' % (k, a, b, '一致' if ok else '★不一致'))
print('-' * 60)
print('包内内容是否一致 :', same)
