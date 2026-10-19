# -*- coding: utf-8 -*-
"""
干净验证：在一个全新的 Chrome 临时配置里，仅靠 HKLM 强制安装策略，
看 Chrome 是否会启用本插件（还是仍然 NOT_VERIFIED 禁用）。

这直接决定「分发给其他用户、只发 install.bat」到底能不能用。
"""
import json
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import time

EXT_ID = 'jklmngkhcjklejabgchcjnbmjgpgmlcl'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'


def appid_of_crx(crx):
    data = open(crx, 'rb').read()
    if data[:4] != b'Cr24':
        return None
    ver = struct.unpack('<I', data[4:8])[0]
    if ver != 3:
        return 'crx v%d(非3)' % ver
    hl = struct.unpack('<I', data[12:16])[0]
    hdr = data[16:16 + hl]
    # CRX3 header 是 protobuf；公钥在 sha256_with_rsa 的 CrxFileHeader 里，
    # 这里只粗略抓形如 <04><len> 后的 DER 公钥头
    i = 0
    pk = None
    # 简化：直接找 PEM 风格不可行，改为对比包内 appid 与已知 ID 是否一致
    return None


def inspect(profile):
    for fn in ('Secure Preferences', 'Preferences'):
        p = os.path.join(profile, fn)
        if not os.path.isfile(p):
            continue
        try:
            d = json.load(open(p, encoding='utf-8', errors='ignore'))
        except Exception:
            continue
        st = (d.get('extensions', {}) or {}).get('settings', {}) or {}
        e = st.get(EXT_ID)
        if e:
            reasons = e.get('disable_reasons', 0)
            if isinstance(reasons, list):
                reasons = [int(x) for x in reasons] or [0]
            else:
                reasons = [int(reasons)]
            return {
                'profile': os.path.basename(profile),
                'file': fn,
                'version': e.get('manifest', {}).get('version'),
                'from_webstore': e.get('from_webstore'),
                'location': e.get('location'),
                'disable_reasons': reasons,
                'was_installed_by_policy': e.get('was_installed_by_default') or e.get('was_installed_by_policy'),
            }
    return None


def main():
    tmp = tempfile.mkdtemp(prefix='xy-polytest-')
    print('临时配置目录: %s' % tmp)
    args = [
        CHROME,
        '--user-data-dir=' + tmp,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate',
        '--no-first-run',
        'about:blank',
    ]
    print('启动 Chrome（全新配置，仅依赖 HKLM 策略）…')
    proc = subprocess.Popen(args)
    # 强制安装发生在启动后不久，等待充分时间
    time.sleep(20)
    # 找该临时配置下的 profile
    rec = None
    for name in os.listdir(tmp):
        prof = os.path.join(tmp, name)
        if os.path.isdir(prof):
            r = inspect(prof)
            if r:
                rec = r
                break
    try:
        proc.terminate()
    except Exception:
        pass
    time.sleep(1)
    try:
        proc.kill()
    except Exception:
        pass

    print('-' * 60)
    if not rec:
        print('结果: 临时配置内【未出现】本插件 —— 策略强制安装没有生效')
        print('可能原因：该 Chrome 版本在临时配置下未触发 file:// 强制安装，')
        print('          或 HKLM 策略未被视为有效（需浏览器重启已运行实例）。')
    else:
        print('结果: 临时配置内【已出现】本插件')
        print('  version            : %s' % rec['version'])
        print('  from_webstore      : %s' % rec['from_webstore'])
        print('  location           : %s' % rec['location'])
        print('  disable_reasons    : %s' % rec['disable_reasons'])
        if 256 in rec['disable_reasons']:
            print('  ⚠ 结论: 即使只走策略，也被 NOT_VERIFIED 禁用 → 本地 file:// 强制安装')
            print('          在此 Chrome 版本不可用，需改用「HTTPS 托管 update.xml」或「解压版手动加载」')
        else:
            print('  ✓ 结论: 仅走策略即被 Chrome 正常启用 → 分发给其他用户可用')
    shutil.rmtree(tmp, ignore_errors=True)
    print('-' * 60)


if __name__ == '__main__':
    main()
