# -*- coding: utf-8 -*-
"""
分发体检工具：检查本机 Chrome / Edge 上「闲鱼助手」的真实安装状态。

能回答两个问题：
  1) 插件到底装上没有？有没有被 Chrome 禁用？禁用原因是什么？
  2) 是否走了正确的「策略强制安装」通道（能绕过非商店校验）？

用法：
    python tools/verify_distribute.py            # 自动检测 Chrome + Edge
    python tools/verify_distribute.py chrome
    python tools/verify_distribute.py edge

适用于 Windows。客户机排查时用它，比让人截图快得多。
"""
import json
import os
import sys

# 由私钥推导的固定扩展 ID（与 build_release.py 保持一致）
EXT_ID = 'jklmngkhcjklejabgchcjnbmjgpgmlcl'

DISABLE_REASON = {
    0: '正常（未禁用）',
    1: '用户手动停用',
    4: '权限升级被停用',
    5: '重载失败被停用',
    8: '不满足运行要求（如内核过低）',
    13: '企业策略要求禁用',
    256: 'NOT_VERIFIED：非商店来源 + 手动安装，被 Chrome 自动禁用（这是“装上但无法运行”的根因）',
}
LOCATION = {
    0: '无效',
    1: 'CRX（来自更新地址/手动拖入）',
    2: 'UNPACKED（解压加载）',
    3: 'COMPONENT（内置组件）',
    5: '通过策略 / 外部扩展清单安装（受信任、不会被 NOT_VERIFIED）',
}


def find_user_data(browser):
    local = os.environ.get('LOCALAPPDATA', '')
    if browser == 'chrome':
        return os.path.join(local, 'Google', 'Chrome', 'User Data')
    return os.path.join(local, 'Microsoft', 'Edge', 'User Data')


def read_json(path):
    try:
        with open(path, 'r', encoding='utf-8', errors='ignore') as f:
            return json.load(f)
    except Exception:
        return None


def inspect_browser(browser):
    ud = find_user_data(browser)
    if not os.path.isdir(ud):
        return None, '未安装或用户数据目录不存在: %s' % ud
    hits = []
    for name in os.listdir(ud):
        prof = os.path.join(ud, name)
        if not os.path.isdir(prof):
            continue
        for fn in ('Secure Preferences', 'Preferences'):
            p = os.path.join(prof, fn)
            if not os.path.isfile(p):
                continue
            d = read_json(p)
            if not d:
                continue
            st = (d.get('extensions', {}) or {}).get('settings', {}) or {}
            e = st.get(EXT_ID)
            if e:
                hits.append((name, fn, e))
    return hits, None


def read_policy(browser):
    try:
        import winreg
    except Exception:
        return '（非 Windows / 无法读取注册表）'
    roots = (
        (winreg.HKEY_CURRENT_USER, r'SOFTWARE\Policies'),
        (winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Policies'),
    )
    vendor = 'Google\\Chrome' if browser == 'chrome' else 'Microsoft\\Edge'
    key = r'%s\%s\ExtensionInstallForcelist' % (vendor, vendor.split('\\')[0])
    found = []
    for hroot, base in roots:
        for sub in (vendor, 'Google\\Chrome', 'Microsoft\\Edge'):
            kpath = r'%s\%s\ExtensionInstallForcelist' % (base, sub)
            try:
                k = winreg.OpenKey(hroot, kpath)
            except OSError:
                continue
            i = 0
            while True:
                try:
                    nm, val, _ = winreg.EnumValue(k, i)
                except OSError:
                    break
                if isinstance(val, str) and val.startswith(EXT_ID + ';'):
                    found.append('%s\\%s\\%s -> %s' % (
                        'HKCU' if hroot == winreg.HKEY_CURRENT_USER else 'HKLM',
                        sub, nm, val))
                i += 1
            winreg.CloseKey(k)
    return found or '（未写策略 —— 即未走正确的强制安装通道）'


def main():
    targets = sys.argv[1:]
    if not targets:
        targets = ['chrome', 'edge']
    print('=' * 64)
    print('闲鱼助手 · 分发体检   扩展 ID: %s' % EXT_ID)
    print('=' * 64)
    for browser in targets:
        if browser not in ('chrome', 'edge'):
            print('未知浏览器参数: %s（用 chrome / edge）' % browser)
            continue
        label = 'Google Chrome' if browser == 'chrome' else 'Microsoft Edge'
        print('\n--- %s ---' % label)

        hits, err = inspect_browser(browser)
        if err:
            print('  ' + err)
        elif not hits:
            print('  [未安装] 没有找到本插件（或客户用的是开发者模式加载的目录，查不到注册记录）')
        else:
            for prof, fn, e in hits:
                reasons = e.get('disable_reasons', 0)
                if isinstance(reasons, list):
                    reasons = [int(x) for x in reasons] or [0]
                else:
                    reasons = [int(reasons)]
                loc = e.get('location', -1)
                print('  配置目录 : %s / %s' % (prof, fn))
                print('  版本     : %s' % e.get('manifest', {}).get('version', '?'))
                print('  来源商店 : %s' % e.get('from_webstore', '?'))
                print('  location : %s' % (LOCATION.get(loc, '未知(%s)' % loc)))
                labels = []
                for r in reasons:
                    labels.append('[%s] %s' % (r, DISABLE_REASON.get(r, '未知(%s)' % r)))
                print('  禁用原因 : %s' % ('；'.join(labels) if labels and reasons != [0] else '正常（未禁用）'))
                if 256 in reasons:
                    print('  ⚠ 结论  : 这是“手动双击 crx 安装”导致的，必须用 install.bat 重装')

        pol = read_policy(browser)
        print('  安装策略 : %s' % (pol if isinstance(pol, str) else '\n    ' + '\n    '.join(pol)))
        print('  通道判定 : %s' % (
            '✓ 已走策略强制安装（绕过非商店校验，其他用户可正常用）'
            if isinstance(pol, list) else
            '✗ 未写策略（普通用户双击 crx 会被禁用；应改用 install.bat）'))
    print('\n' + '=' * 64)
    print('一句话：要让“其他用户能用”，发给他们整个安装包(zip)，让他们双击 install.bat，')
    print('不要只发 .crx 文件。')
    print('=' * 64)


if __name__ == '__main__':
    main()
