#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
校验「一个目录能不能被 Chrome 当作未打包扩展加载」。

存在的理由：手动加载时会遇到浏览器提示「清单文件缺失或不可读取」，
而这个提示几乎不指向真正的原因（90% 情况是选错了目录，或清单引用的文件缺失）。
本工具按 Chrome 的解析规则逐条核对，把机械性原因提前暴露出来。

用法:
    python tools/verify_unpacked.py <扩展目录或安装包zip>
    python tools/verify_unpacked.py dist/release/extension
"""
import io
import json
import os
import re
import subprocess
import sys
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = os.path.join(os.path.dirname(ROOT), '.workbuddy', 'binaries', 'node',
                    'versions', '22.22.2-3', 'node.exe')
for cand in (NODE, 'node', 'node.exe'):
    try:
        subprocess.run([cand, '--version'], capture_output=True, timeout=10)
        NODE = cand
        break
    except Exception:
        continue

errors = []
warnings = []
checked = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def open_bytes(p):
    with open(p, 'rb') as f:
        return f.read()


def load_manifest(raw):
    """按 Chrome 的严格度解析清单：不允许 BOM，必须是合法 UTF-8 JSON"""
    if raw.startswith(b'\xef\xbb\xbf'):
        err('manifest.json 带 UTF-8 BOM，Chrome 无法解析')
        return None
    try:
        text = raw.decode('utf-8')
    except UnicodeDecodeError as e:
        err('manifest.json 不是合法 UTF-8: %s' % e)
        return None
    try:
        return json.loads(text)
    except ValueError as e:
        err('manifest.json JSON 语法错误: %s' % e)
        return None


def check(dir_path, label):
    print('检查目录: %s  (%s)' % (label, dir_path))
    man_p = os.path.join(dir_path, 'manifest.json')
    if not os.path.isfile(man_p):
        err('根目录缺少 manifest.json —— 浏览器会报「清单文件缺失或不可读取」。'
            '「加载已解压的扩展程序」必须选中这一层。')
        return
    checked.append('根目录 manifest.json 存在')
    m = load_manifest(open_bytes(man_p))
    if m is None:
        return
    checked.append('manifest.json 可解析 (v%s)' % m.get('version'))

    for key in ('manifest_version', 'version', 'name'):
        if key not in m:
            err('manifest 缺少必填字段: %s' % key)

    # 1) 图标
    for size, icon in sorted((m.get('icons') or {}).items(), key=lambda x: int(x[0])):
        if not os.path.isfile(os.path.join(dir_path, icon)):
            err('icons 声明的 %s 不存在: %s' % (size, icon))

    # 2) background / service worker
    bg = m.get('background')
    if isinstance(bg, dict) and bg.get('service_worker'):
        sw = os.path.join(dir_path, bg['service_worker'])
        if not os.path.isfile(sw):
            err('background.service_worker 指向的文件不存在: %s' % bg['service_worker'])
        else:
            check_js(sw)

    # 3) content_scripts 与 web_accessible_resources 的 js/css
    for cs in (m.get('content_scripts') or []):
        for js in cs.get('js', []):
            p = os.path.join(dir_path, js)
            if not os.path.isfile(p):
                err('content_scripts.js 文件不存在: %s' % js)
            else:
                check_js(p)
        for css in cs.get('css', []):
            if not os.path.isfile(os.path.join(dir_path, css)):
                err('content_scripts.css 文件不存在: %s' % css)

    for w in (m.get('web_accessible_resources') or []):
        res = w.get('resources') if isinstance(w, dict) else w
        for r in (res or []):
            if '*' in str(r):
                continue
            if not os.path.exists(os.path.join(dir_path, r)):
                err('web_accessible_resources 缺失: %s' % r)

    # 4) options_ui / chrome_url_overrides / devtools_page
    for key in ('options_page', 'options_ui', 'chrome_url_overrides', 'devtools_page', 'sidebar_action'):
        v = m.get(key)
        if not v:
            continue
        if isinstance(v, dict):
            v = v.get('page')
        if isinstance(v, str) and v:
            if not os.path.isfile(os.path.join(dir_path, v)):
                err('%s 指向的页面不存在: %s' % (key, v))
            elif v.endswith('.js'):
                check_js(os.path.join(dir_path, v))

    # 5) 目录里残留的旧结构提示（说明这层不是扩展根）
    if os.path.isdir(os.path.join(dir_path, 'extension')) and \
            os.path.isfile(os.path.join(dir_path, 'extension', 'manifest.json')):
        warn('本目录下还有一层 extension/ 子目录，那边才是扩展根目录；'
             '本层缺少 manifest.json，选中本层会失败。')


def check_js(p):
    if not JS_OK:
        return
    r = subprocess.run([NODE, '--check', p], capture_output=True, timeout=60)
    if r.returncode != 0:
        err('%s 语法错误: %s' % (os.path.basename(p),
                                 r.stderr.decode('utf-8', 'replace').strip()[:200]))
    else:
        checked.append('%s 语法 OK' % os.path.basename(p))


JS_OK = True
try:
    subprocess.run([NODE, '--version'], capture_output=True, timeout=10)
except Exception:
    JS_OK = False
    warn('未找到 node，跳过 JS 语法检查')


def check_zip(path):
    print('检查安装包: %s' % path)
    z = zipfile.ZipFile(path)
    names = z.namelist()
    root_man = [n for n in names if n == 'manifest.json']
    if not root_man:
        err('zip 根目录没有 manifest.json —— 用户解压后只要不选这一层就会失败。')
        warn('当前 zip 中 manifest.json 位于: %s'
             % ', '.join(n for n in names if n.endswith('manifest.json')) or '未知')
    else:
        checked.append('zip 根目录含 manifest.json')
        raw = z.read('manifest.json')
        m = load_manifest(raw)
        if m:
            checked.append('manifest v%s 可解析' % m.get('version'))
            for cs in (m.get('content_scripts') or []):
                for js in cs.get('js', []):
                    if js not in names:
                        err('content_scripts.js 不在包内: %s' % js)
                for css in cs.get('css', []):
                    if css not in names:
                        err('content_scripts.css 不在包内: %s' % css)
            for size, icon in sorted((m.get('icons') or {}).items(), key=lambda x: int(x[0])):
                if icon not in names:
                    err('icons 文件不在包内: %s' % icon)
            sw = (m.get('background') or {}).get('service_worker') if isinstance(m.get('background'), dict) else None
            if sw and sw not in names:
                err('service_worker 不在包内: %s' % sw)


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    target = sys.argv[1]
    if target.endswith('.zip'):
        check_zip(target)
    else:
        if not os.path.isdir(target):
            print('目录不存在: %s' % target)
            return 2
        check(target, '未打包扩展')

    print('-' * 58)
    for c in checked:
        print('  [OK] ' + c)
    for w in warnings:
        print('  [!!] ' + w)
    for e in errors:
        print('  [NG] ' + e)
    print('-' * 58)
    if errors:
        print('结论: 该目录不能被 Chrome 正常加载（%d 项问题）' % len(errors))
        return 1
    print('结论: 结构校验通过，Chrome 可正常解析该扩展目录')
    return 0


if __name__ == '__main__':
    sys.exit(main())
