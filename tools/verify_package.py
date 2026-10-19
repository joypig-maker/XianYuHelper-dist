# -*- coding: utf-8 -*-
"""
发布包静态校验（不依赖浏览器，也不需要写注册表）

对 dist/release/XianYuHelper.crx 做发行级检查：
  1. CRX3 容器头是否合法
  2. 包内签名公钥推出的扩展 ID，是否与 build/xyext.pem 一致（决定能否静默升级）
  3. ZIP 载荷完整性 + 关键文件是否齐全
  4. update.xml 中的 appid / codebase / version 是否与包一致
  5. 随包解压版 extension/ 是否与 crx 内容一致（兜底路径可用）

用途：每次 python tools/build_release.py 之后跑一次，确认交付件没有残缺。
"""
import hashlib
import io
import json
import os
import glob
import struct
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, 'tools'))

RELEASE = os.path.join(ROOT, 'dist', 'release')
DIST = os.path.join(ROOT, 'dist')
CRX = os.path.join(RELEASE, 'XianYuHelper.crx')
KEY = os.path.join(ROOT, 'build', 'xyext.pem')
UNPACKED = os.path.join(RELEASE, 'extension')

from build_release import extension_id, spki_from_pem  # noqa: E402

REQUIRED_FILES = [
    'manifest.json',
    'icons/icon-128.png',
    'src/background/service_worker.js',
    'src/content/injected.js',
    'src/content/bridge.js',
    'src/content/panel.css',
    'src/common/util.js',
    'src/common/postbus.js',
    'src/common/extract.js',
    'src/popup/popup.html',
    'src/popup/popup.js',
]

ok = True


def check(label, condition, detail=''):
    global ok
    ok = ok and bool(condition)
    print('  [%s] %-42s %s' % ('OK ' if condition else 'NG ', label, detail))


def pb_fields(buf):
    """极简 protobuf 遍历：返回 [(field_no, wire_type, value_bytes)]"""
    out, i = [], 0
    while i < len(buf):
        n, i2 = 0, i
        shift = 0
        while True:
            b = buf[i2]
            i2 += 1
            n |= (b & 0x7F) << shift
            shift += 7
            if not (b & 0x80):
                break
        tag = n
        i = i2
        field, wire = tag >> 3, tag & 7
        if wire == 2:
            ln = 0
            shift = 0
            while True:
                b = buf[i]
                i += 1
                ln |= (b & 0x7F) << shift
                shift += 7
                if not (b & 0x80):
                    break
            out.append((field, wire, buf[i:i + ln]))
            i += ln
        elif wire == 0:
            ln = 0
            shift = 0
            while True:
                b = buf[i]
                i += 1
                ln |= (b & 0x7F) << shift
                shift += 7
                if not (b & 0x80):
                    break
            out.append((field, wire, buf[i - 1:i]))
            i = i  # varint 已读完
        elif wire == 5:
            out.append((field, wire, buf[i:i + 4]))
            i += 4
        elif wire == 1:
            out.append((field, wire, buf[i:i + 8]))
            i += 8
        else:
            break
    return out


def crx3_pubkey(data):
    """从 CRX3 header 中取出签名公钥 (SubjectPublicKeyInfo DER)"""
    if data[:4] != b'Cr24':
        raise ValueError('不是合法的 crx 容器（magic=%r）' % data[:4])
    version = struct.unpack('<I', data[4:8])[0]
    if version != 3:
        raise ValueError('只支持 CRX3，当前版本=%d' % version)
    header_len = struct.unpack('<I', data[8:12])[0]
    header = data[12:12 + header_len]
    payload = data[12 + header_len:]

    for f, wire, val in pb_fields(header):
        if f == 2:  # Asn1Message
            for f2, w2, v2 in pb_fields(val):
                if f2 == 1:
                    return version, v2, payload
    raise ValueError('CRX3 header 中未找到公钥')


def main():
    print('=' * 62)
    print('发布包静态校验')
    print('=' * 62)

    if not os.path.isfile(CRX):
        print('未找到 %s，请先运行 python tools/build_release.py' % CRX)
        return 1
    data = open(CRX, 'rb').read()

    print('\n[1] CRX3 容器')
    version, pubkey, payload = crx3_pubkey(data)
    check('容器标识 Cr24 + version=3', True, 'version=%d, header=%d bytes'
          % (version, struct.unpack('<I', data[8:12])[0]))
    check('载荷为有效 ZIP', payload[:2] == b'PK', '%d bytes' % len(payload))

    print('\n[2] 签名与扩展 ID')
    crx_id = ''.join(chr(ord('a') + (b >> 4)) + chr(ord('a') + (b & 0xF))
                     for b in hashlib.sha256(pubkey).digest()[:16])
    pem_id = extension_id(KEY)
    check('包内公钥与私钥匹配', crx_id == pem_id, 'crx=%s' % crx_id)
    check('ID 符合 32 位 a-p 规范', len(crx_id) == 32, pem_id)
    idfile = os.path.join(RELEASE, 'EXTENSION_ID.txt')
    declared = open(idfile, encoding='utf-8').read().split()[0] if os.path.isfile(idfile) else ''
    check('EXTENSION_ID.txt 与包一致', declared == crx_id, declared)

    print('\n[3] 载荷完整性')
    z = zipfile.ZipFile(io.BytesIO(payload))
    bad = z.testzip()
    check('ZIP 完整性', bad is None, bad or '无损坏')
    names = z.namelist()
    missing = [f for f in REQUIRED_FILES if f not in names]
    check('关键文件齐全', not missing, missing[0] if missing else '%d 个文件' % len(names))

    manifest = json.loads(z.read('manifest.json').decode('utf-8'))
    check('manifest_version = 3', manifest.get('manifest_version') == 3)
    check('发布版带 update_url', bool(manifest.get('update_url')), manifest.get('update_url', ''))
    print('       version=%s  name=%s' % (manifest.get('version'), manifest.get('name')))

    # 站点覆盖：漏配一个域名 = 那个站点上插件完全静默（没面板、没提示），
    # 而出包校验照样全绿。淘宝接入时就踩过这个——代码全写完，
    # 但 matches 只列了 goofish/xianyu/1688，淘宝页面一条 content script 都不注入。
    SITES = ['goofish.com', 'xianyu.com', '1688.com', 'taobao.com', 'tmall.com']
    groups = manifest.get('content_scripts') or []
    check('有 content_scripts 分组', len(groups) >= 2, '%d 组' % len(groups))
    for gi, g in enumerate(groups):
        pats = ' '.join(g.get('matches') or [])
        lack = [s for s in SITES if s not in pats]
        check('第 %d 组 matches 覆盖全部站点' % (gi + 1), not lack,
              '缺 ' + ', '.join(lack) if lack else ' / '.join(SITES))
    hp = ' '.join(manifest.get('host_permissions') or [])
    lack_hp = [s for s in SITES if s not in hp]
    check('host_permissions 覆盖全部站点', not lack_hp,
          '缺 ' + ', '.join(lack_hp) if lack_hp else 'ok')
    # 两个世界的脚本组必须都带上站点配置，否则 MAIN 侧认不出域名
    for gi, g in enumerate(groups):
        check('第 %d 组加载了 sites.js' % (gi + 1), 'src/common/sites.js' in (g.get('js') or []))

    # 反向查一遍：manifest 里声明了的文件必须真实存在。
    # 漏这一项的话，新增脚本忘了 cp 进 staging / 打进 crx 时，
    # 上面「关键文件齐全」只看白名单照样通过，浏览器却会因找不到脚本整个哑掉。
    declared = []
    for grp in manifest.get('content_scripts', []):
        declared += list(grp.get('js', []))
    declared += [manifest['background']['service_worker']]
    absent = [f for f in declared if f not in names]
    check('manifest 声明的文件在包内均存在', not absent, absent[0] if absent else '%d 个声明文件' % len(declared))

    # 上面「关键文件齐全」过，不代表新脚本真的挂到了某个 content_scripts 组里。
    # 漏挂 = 脚本存在但从未执行，症状是功能缺失且无任何报错，极难定位。
    wired = set(declared)
    orphan = [f for f in ('src/common/postbus.js', 'src/common/extract.js') if f not in wired]
    check('新脚本已挂进 content_scripts', not orphan, orphan[0] if orphan else 'postbus / extract 均已挂载')
    mw = [g for g in manifest.get('content_scripts', []) if g.get('world') == 'MAIN']
    mwjs = set(sum([g.get('js', []) for g in mw], []))
    check('extract.js 在 MAIN world 组（fiber/全局数据只在主世界可见）',
          'src/common/extract.js' in mwjs)

    print('\n[4] update.xml')
    xml = open(os.path.join(RELEASE, 'update.xml'), encoding='utf-8').read()
    check('appid 与包一致', "appid='%s'" % crx_id in xml)
    check('codebase 指向同一目录下的 crx', 'codebase=' in xml and 'XianYuHelper.crx' in xml)
    check('version 与 manifest 一致', "version='%s'" % manifest['version'] in xml)

    print('\n[5] 兜底解压版 extension/')
    if not os.path.isdir(UNPACKED):
        check('存在解压版目录', False)
        return 1
    check('存在解压版目录', True)
    up_manifest = json.loads(open(os.path.join(UNPACKED, 'manifest.json'), encoding='utf-8').read())
    check('内容与 crx 同源（除 update_url）',
          up_manifest.get('version') == manifest.get('version'),
          'version=%s' % up_manifest.get('version'))
    check('解压版不含 update_url', 'update_url' not in up_manifest)
    missing2 = [f for f in REQUIRED_FILES
                if not os.path.isfile(os.path.join(UNPACKED, f))]
    check('关键文件齐全', not missing2, missing2[0] if missing2 else '全部就位')

    print('\n[6] 客户安装包结构（决定手动加载能否一次成功）')
    dists = sorted(glob.glob(os.path.join(DIST, '闲鱼助手-安装包-v*.zip')),
                   key=os.path.getmtime, reverse=True)
    if not dists:
        check('存在客户安装包', False)
        return 1
    latest = dists[0]
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'verify_unpacked.py'), latest],
                       capture_output=True, text=True, encoding='utf-8')
    print('       最新安装包: %s' % os.path.basename(latest))
    for line in (r.stdout or '').strip().splitlines():
        if line.strip():
            print('       ' + line.strip())
    # 这一项失败即意味着客户照着提示操作也会失败，属于必过项
    check('安装包根目录可直接作为扩展目录', r.returncode == 0)

    print('\n' + '=' * 62)
    print('结论: %s' % ('发布包校验通过，可交付' if ok else '存在问题，请修复后再发布'))
    print('=' * 62)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
