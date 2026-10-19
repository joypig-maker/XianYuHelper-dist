# -*- coding: utf-8 -*-
"""
决定性实验：用本机 HTTP(127.0.0.1) 作为强制安装的更新源，
验证 Chrome 154 的「网络型更新源强制安装」机制是否还工作。
- 若安装成功 -> file:// 被封是根因，HTTPS 托管即可解决（分发的正确路线）
- 若仍失败   -> 强制安装机制在本环境整体不可用，只能走解压版手动加载

会临时改写 HKLM 策略并还原；仅用 localhost，不连外网。
"""
import http.server
import json
import os
import socketserver
import subprocess
import sys
import tempfile
import threading
import time

EXT_ID = 'jklmngkhcjklejabgchcjnbmjgpgmlcl'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'
CRX = r'C:\Users\Public\XianYuHelper\XianYuHelper.crx'
POLICY_KEY = r'SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
PORT = 8899


def make_update_xml():
    return (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='%s'>\n"
        "    <updatecheck codebase='http://127.0.0.1:%d/XianYuHelper.crx' version='1.0.0' />\n"
        "  </app>\n"
        "</gupdate>\n"
    ) % (EXT_ID, PORT)


class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_GET(self):
        if self.path.endswith('update.xml'):
            body = make_update_xml().encode()
            self.send_response(200); self.send_header('Content-Type', 'text/xml')
            self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body)
        elif self.path.endswith('.crx'):
            body = open(CRX, 'rb').read()
            self.send_response(200); self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Length', str(len(body))); self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404); self.end_headers()


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
            return {'file': fn, 'version': e.get('manifest', {}).get('version'),
                    'from_webstore': e.get('from_webstore'), 'location': e.get('location'),
                    'disable_reasons': reasons}
    return None


def main():
    # 1) 起本地 HTTP
    httpd = socketserver.TCPServer(('127.0.0.1', PORT), Handler)
    t = threading.Thread(target=httpd.serve_forever, daemon=True); t.start()
    print('本地 HTTP 已起: http://127.0.0.1:%d' % PORT)

    # 2) 备份并改写 HKLM 策略
    backup = None
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 0, winreg.KEY_READ)
        backup = {}
        i = 0
        while True:
            try:
                nm, val, _ = winreg.EnumValue(k, i)
            except OSError:
                break
            backup[nm] = val
            i += 1
        winreg.CloseKey(k)
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 0, winreg.KEY_SET_VALUE)
        winreg.SetValueEx(k, '99', 0, winreg.REG_SZ, EXT_ID + ';http://127.0.0.1:%d/update.xml' % PORT)
        winreg.CloseKey(k)
        print('已临时改写 HKLM 策略为 http://127.0.0.1 更新源')
    except Exception as e:
        print('HKLM 写入失败（无管理员权限？）: %s' % e)
        httpd.shutdown(); return

    # 3) 干净配置启动 Chrome
    tmp = tempfile.mkdtemp(prefix='xy-httptest-')
    args = [CHROME, '--user-data-dir=' + tmp, '--no-first-run', '--no-default-browser-check',
            '--disable-features=Translate', 'about:blank']
    print('启动 Chrome（干净配置，仅依赖 HKLM 策略）…')
    proc = subprocess.Popen(args)
    time.sleep(25)
    rec = None
    for name in os.listdir(tmp):
        prof = os.path.join(tmp, name)
        if os.path.isdir(prof):
            r = inspect(prof)
            if r:
                rec = r; break
    try: proc.terminate()
    except Exception: pass
    time.sleep(1)
    try: proc.kill()
    except Exception: pass

    # 4) 还原 HKLM 策略
    try:
        import winreg
        k = winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE, POLICY_KEY, 0, winreg.KEY_SET_VALUE)
        try: winreg.DeleteValue(k, '99')
        except OSError: pass
        for nm, val in backup.items():
            winreg.SetValueEx(k, nm, 0, winreg.REG_SZ, val)
        winreg.CloseKey(k)
        print('HKLM 策略已还原')
    except Exception as e:
        print('HKLM 还原失败: %s（请手动检查）' % e)

    httpd.shutdown()
    import shutil; shutil.rmtree(tmp, ignore_errors=True)

    print('-' * 60)
    if not rec:
        print('结果: 本机 HTTP 更新源也【未安装】 -> 强制安装机制在本 Chrome 不可用，')
        print('      分发只能走「解压版 + 开发者模式手动加载」兜底。')
    else:
        print('结果: 本机 HTTP 更新源【成功安装】')
        print('  version=%s from_webstore=%s location=%s disable_reasons=%s'
              % (rec['version'], rec['from_webstore'], rec['location'], rec['disable_reasons']))
        if 256 in rec['disable_reasons']:
            print('  ⚠ 仍被 NOT_VERIFIED 禁用（即使网络源）——需进一步排查')
        else:
            print('  ✓ 网络型更新源可强制安装且未被禁用 -> 改用 HTTPS 托管即可分发')
    print('-' * 60)


if __name__ == '__main__':
    main()
