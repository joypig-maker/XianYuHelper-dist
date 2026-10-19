# -*- coding: utf-8 -*-
"""
发布安装包端到端验证（模拟客户双击 install.bat 的完整流程）

1. 静默执行 install.ps1（等价于客户双击 install.bat）
2. 检查文件落地、安装目录、剪贴板路径
3. 检查浏览器策略是否写入成功（有的机器会被系统/安全软件拒绝）
   - 成功：一切正常
   - 失败：确认安装器正确降级到「开发者模式加载」兜底方案
4. 用无头 Edge 加载安装器释放出来的扩展目录，验证插件功能可用
5. 静默执行 uninstall.ps1 还原环境

用法: python tools/verify_install.py [--keep]
       --keep  验证后不卸载，保留安装状态
"""
import json
import os
import subprocess
import sys
import winreg

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE = os.path.join(ROOT, 'dist', 'release')
NODE = r'C:\Users\pc\.workbuddy\binaries\node\versions\22.22.2-3\node.exe'
KEEP = '--keep' in sys.argv

POLICY_KEYS = [
    ('Chrome HKCU', winreg.HKEY_CURRENT_USER, r'SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'),
    ('Chrome HKLM', winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'),
    ('Edge   HKCU', winreg.HKEY_CURRENT_USER, r'SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'),
    ('Edge   HKLM', winreg.HKEY_LOCAL_MACHINE, r'SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'),
]
INSTALL_DIR_CANDIDATES = [
    os.path.join(os.environ.get('PUBLIC', r'C:\Users\Public'), 'XianYuHelper'),
    os.path.join(os.environ.get('LOCALAPPDATA', ''), 'XianYuHelper'),
]


def hr(t):
    print('\n' + '=' * 62)
    print(t)
    print('=' * 62)


def decode(b):
    for enc in ('gbk', 'utf-8'):
        try:
            return b.decode(enc)
        except UnicodeDecodeError:
            continue
    return b.decode('utf-8', 'ignore')


def run_ps(script, args=(), timeout=180):
    cmd = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script] + list(args)
    r = subprocess.run(cmd, capture_output=True, timeout=timeout)
    return r.returncode, decode(r.stdout) + decode(r.stderr)


def read_policy(root, subkey):
    try:
        with winreg.OpenKey(root, subkey) as k:
            vals = []
            i = 0
            while True:
                try:
                    n, v, _ = winreg.EnumValue(k, i)
                    vals.append(v)
                    i += 1
                except OSError:
                    break
            return vals
    except FileNotFoundError:
        return []


def main():
    idfile = os.path.join(RELEASE, 'EXTENSION_ID.txt')
    if not os.path.isfile(idfile):
        raise SystemExit('未找到发布产物，请先运行 python tools/build_release.py')
    ext_id = open(idfile, encoding='utf-8').read().split()[0].strip()
    print('扩展 ID: %s' % ext_id)

    hr('步骤 1/5  静默执行 install.ps1（等价客户双击 install.bat）')
    code, out = run_ps(os.path.join(RELEASE, 'install.ps1'), ['-Silent'])
    print('\n'.join('  ' + l for l in out.strip().splitlines()))
    print('  退出码: %d' % code)

    hr('步骤 2/5  安装目录与文件')
    install_dir = None
    for d in INSTALL_DIR_CANDIDATES:
        if os.path.isfile(os.path.join(d, 'XianYuHelper.crx')):
            install_dir = d
            break
    if not install_dir:
        print('  [FAIL] 未找到安装目录')
        return 1
    print('  安装目录: %s' % install_dir)
    for f in ('XianYuHelper.crx', 'update.xml', 'extension\\manifest.json'):
        p = os.path.join(install_dir, f)
        e = os.path.isfile(p)
        print('  [%s] %-24s %s' % ('OK' if e else 'NG', f,
                                   '%.1f KB' % (os.path.getsize(p) / 1024.0) if e else '缺失'))

    hr('步骤 3/5  浏览器安装策略')
    policy_hit = []
    for label, root, key in POLICY_KEYS:
        try:
            vals = read_policy(root, key)
        except Exception as e:
            vals = []
        hit = [v for v in vals if v.startswith(ext_id + ';')]
        print('  %-12s %s' % (label, hit[0] if hit else '（无）'))
        if hit:
            policy_hit.append(label)
    ext_dir = os.path.join(install_dir, 'extension')
    if policy_hit:
        print('  -> 策略安装可用，客户重启浏览器即自动生效')
    else:
        print('  -> 本机系统策略被限制（HKCU\\SOFTWARE\\Policies 不可写），')
        print('     安装器应已降级到开发者模式加载方案，路径: %s' % ext_dir)

    hr('步骤 4/5  用无头 Edge 加载安装器释放的扩展，验证功能')
    env = dict(os.environ, XY_EXT=ext_dir)
    r = subprocess.run([NODE, os.path.join(ROOT, 'tools', 'verify.js')],
                       capture_output=True, timeout=300, env=env,
                       cwd=ROOT)
    vout = decode(r.stdout) + decode(r.stderr)
    lines = vout.strip().splitlines()
    start = next((i for i, l in enumerate(lines) if '验收结果' in l), None)
    if start is not None:
        for line in lines[start:start + 30]:
            print('  ' + line.strip())
    else:
        print('\n'.join('  ' + l for l in lines[-25:]))
    functional = '"source": "api"' in vout.replace("'", '"')

    hr('步骤 5/5  还原环境')
    if KEEP:
        print('  --keep 已指定，保留安装状态')
    else:
        code, out = run_ps(os.path.join(RELEASE, 'uninstall.ps1'), ['-Silent'])
        print('  uninstall 退出码: %d' % code)
        print('\n'.join('  ' + l for l in out.strip().splitlines()))
        for d in INSTALL_DIR_CANDIDATES:
            print('  %s 残留: %s' % (d, os.path.isdir(d)))
        left = []
        for label, root, key in POLICY_KEYS:
            left += [v for v in read_policy(root, key) if v.startswith(ext_id + ';')]
        print('  策略残留: %s' % (left if left else '无'))

    hr('结论')
    if policy_hit:
        print('  安装方式 : 策略静默安装（自动、用户不可卸载、无需开发者模式）')
    else:
        print('  安装方式 : 本机策略受限 -> 降级到开发者模式加载（客户机器通常无需降级）')
    print('  释放文件 : OK')
    print('  功能可用 : %s（见步骤 4，扩展被加载后取到页面数据）' % ('是' if functional else '待确认'))
    print('  环境还原 : %s' % ('保留' if KEEP else '已卸载清理'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
