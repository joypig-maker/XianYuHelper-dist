# -*- coding: utf-8 -*-
"""
查询本机所有 Chromium 浏览器里「闲鱼助手」的安装状态，并翻译 Chrome/Edge 的停用原因。

解决的核心问题：非 Chrome 应用商店来源的扩展，会被 Chrome 以
DISABLE_NOT_VERIFIED(=256) 直接停用 —— 表现为「装上了但无法运行」。
这个文件能在 3 秒内分辨出到底是「没装上」「被商店校验拦下」还是「正常」。

用法:
    python tools/check_status.py
"""
import glob
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
IDFILE = os.path.join(ROOT, 'dist', 'release', 'EXTENSION_ID.txt')

if os.path.isfile(IDFILE):
    EXT_ID = open(IDFILE, encoding='utf-8').read().split()[0].strip()
else:
    EXT_ID = sys.argv[1] if len(sys.argv) > 1 else ''

BROWSERS = [
    ('Google Chrome', os.path.expandvars(r'%LOCALAPPDATA%\Google\Chrome\User Data')),
    ('Microsoft Edge', os.path.expandvars(r'%LOCALAPPDATA%\Microsoft\Edge\User Data')),
]

# Chrome Extension::DisableReason（位掩码）
DISABLE_REASONS = {
    0: '正常启用',
    1: 'PERMISSIONS_INCREASE 权限提升需用户重新确认',
    2: 'USER_ACTION 用户手动停用',
    4: 'UNSUPPORTED_REQUIREMENT 依赖不受支持',
    8: 'SIDELOADING 侧载限制',
    16: 'EXTERNAL_EXTENSION 外部来源被拒',
    32: 'UPDATE_REQUIRED_BY_POLICY 策略要求更新',
    64: 'CUSTODIAN_APPROVAL_REQUIRED 需监护人批准',
    128: 'REINSTALL 需要重新安装',
    256: 'NOT_VERIFIED 【未通过商店验证】非商店来源，Chrome 拒绝运行',
    512: 'GREYLIST 灰名单',
    1024: 'CORRUPTED 包损坏',
    2048: 'REMOTE_INSTALL 远程安装限制',
}

LOCATIONS = {
    0: 'INVALID', 1: 'INTERNAL', 2: 'EXTERNAL_PREF', 3: 'EXTERNAL_REGISTRY',
    4: 'UNPACKED(开发者模式加载)', 5: 'COMPONENT', 6: 'EXTERNAL_PREF_DOWNLOADED',
    7: 'EXTERNAL_POLICY_DOWNLOADED(策略安装)', 8: 'COMMAND_LINE',
    9: 'EXTERNAL_POLICY', 10: 'EXTERNAL_COMPONENT',
}


def load_json(p):
    try:
        with open(p, encoding='utf-8', errors='ignore') as f:
            return json.load(f)
    except Exception:
        return None


def profile_dirs(udata):
    if not os.path.isdir(udata):
        return []
    dirs = []
    for name in os.listdir(udata):
        d = os.path.join(udata, name)
        if os.path.isfile(os.path.join(d, 'Preferences')) or \
           os.path.isfile(os.path.join(d, 'Secure Preferences')):
            dirs.append((name, d))
    return dirs


def inspect(ext_id):
    print('=' * 66)
    print('闲鱼助手 安装状态检查')
    print('扩展 ID: %s' % (ext_id or '（未指定）'))
    print('=' * 66)

    found_any = False
    for bname, udata in BROWSERS:
        print('\n--- %s ---' % bname)
        if not os.path.isdir(udata):
            print('  未安装（无用户数据目录）')
            continue
        profiles = profile_dirs(udata)
        if not profiles:
            print('  未找到 profile')
            continue
        hit = False
        for pname, pdir in profiles:
            ext_root = os.path.join(pdir, 'Extensions', ext_id)
            has_dir = os.path.isdir(ext_root)
            entry = None
            for pref in ('Secure Preferences', 'Preferences'):
                d = load_json(os.path.join(pdir, pref))
                if d:
                    entry = d.get('extensions', {}).get('settings', {}).get(ext_id)
                    if entry:
                        break
            if not entry and not has_dir:
                continue
            hit = True
            found_any = True
            print('  [%s]' % pname)
            if not entry:
                print('    磁盘有目录但无安装记录（残留）: %s' % ext_root)
                continue
            state = entry.get('state')
            reasons = entry.get('disable_reasons', []) or []
            loc = entry.get('location')
            masked = [(r, DISABLE_REASONS.get(r, '未知原因 %d' % r)) for r in reasons]
            total = 0
            for r, _ in masked:
                total |= r
            if total == 0 and masked:
                total = masked[0][0]
            status = DISABLE_REASONS.get(total, '未知组合 %d' % total) if total else '正常启用'
            print('    %-14s %s' % ('状态', '✔ 运行中' if total == 0 else '✘ 已停用'))
            print('    %-14s %s' % ('原因', status))
            print('    %-14s %s' % ('安装位置', LOCATIONS.get(loc, loc)))
            print('    %-14s %s' % ('来自商店', entry.get('from_webstore')))
            print('    %-14s %s' % ('版本', (entry.get('manifest') or {}).get('version')))
            print('    %-14s %s' % ('目录', os.path.join('Extensions', entry.get('path', ''))))
        if not hit:
            print('  未安装本插件')

    print('\n' + '=' * 66)
    if not found_any:
        print('结论: 本机 Chrome / Edge 均未安装本插件')
        print('      做法: 右键 install.bat → 以管理员身份运行，然后重启浏览器')
    print('常见结论对照：')
    print('  · NOT_VERIFIED(256) → 非商店来源被 Chrome 拒绝，必须改用「策略安装」')
    print('    或「开发者模式加载目录」，直接装 crx 一定被拦')
    print('  · 状态 ✔ 且安装位置为 EXTERNAL_POLICY* → 策略安装成功，可长期使用')
    print('  · 状态 ✔ 且安装位置为 UNPACKED → 开发者模式加载，删除后重开会带警告条')
    print('=' * 66)
    return 0


if __name__ == '__main__':
    if not EXT_ID:
        print('未找到 dist/release/EXTENSION_ID.txt，请传入扩展 ID 或先构建')
        sys.exit(1)
    sys.exit(inspect(EXT_ID))
