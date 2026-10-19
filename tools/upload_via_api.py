# -*- coding: utf-8 -*-
"""
绕过 git，直接用 GitHub Contents API 推送文件（curl 上传，规避本机 git 代理/TLS 限制）。

用法：
  python tools/upload_via_api.py --token <token> --repo XianYuHelper-dist --user <user>
"""
import argparse
import base64
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REPO_DIR = os.path.join(ROOT, 'deploy', 'XianYuHelper-dist')
SECRET = []


def redact(s):
    for t in SECRET:
        if t:
            s = s.replace(t, '***')
    return s


def api(method, path, token, payload=None):
    """所有请求走系统 curl（本机 Python TLS 缺 CA，curl 用 Schannel 正常）"""
    url = 'https://api.github.com' + path
    with tempfile.NamedTemporaryFile('w+', suffix='.json', delete=False, encoding='utf-8') as f:
        f.write(json.dumps(payload, ensure_ascii=False))
        body_path = f.name
    cmd = ['curl', '-sS', '-X', method, url,
           '-w', '\n%{http_code}',
           '-H', 'Authorization: Bearer ' + token,
           '-H', 'Accept: application/vnd.github+json',
           '-H', 'Content-Type: application/json',
           '-H', 'User-Agent: xy-ext-deploy',
           '--data-binary', '@' + body_path]
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    os.unlink(body_path)
    body, _, code = r.stdout.rstrip('\n').rpartition('\n')
    if not code.isdigit() or int(code) >= 400:
        raise RuntimeError('API %s %s -> HTTP %s: %s'
                           % (method, path, code, redact((body or r.stderr)[:400])))
    try:
        return json.loads(body) if body.strip() else {}
    except Exception:
        return {}


def blob_sha(data):
    """算 git blob 的 sha —— GitHub Contents API 返回的 sha 就是它，用来判断内容有没有变。"""
    import hashlib
    h = hashlib.sha1()
    h.update(b'blob %d\0' % len(data))
    h.update(data)
    return h.hexdigest()


def push_file(token, user, repo, rel_path, local_path, msg):
    import urllib.parse
    enc = urllib.parse.quote(rel_path)
    existing = api('GET', '/repos/%s/%s/contents/%s?ref=main' % (user, repo, enc), token)
    with open(local_path, 'rb') as f:
        data = f.read()
    # 内容没变就别推了。否则每次发布都会给没改过的文件（比如 README）
    # 造一个空 commit，仓库历史很快就被这种噪音淹掉。
    if isinstance(existing, dict) and existing.get('sha') == blob_sha(data):
        return {'skipped': True}
    b64 = base64.b64encode(data).decode()
    payload = {
        'message': msg,
        'content': b64,
        'branch': 'main',
        'committer': {'name': 'XianYuHelper Deploy', 'email': 'xy-ext@example.com'},
    }
    if isinstance(existing, dict) and existing.get('sha'):
        payload['sha'] = existing['sha']   # 已存在则必须带 sha，否则 422
    return api('PUT', '/repos/%s/%s/contents/%s' % (user, repo, enc), token, payload)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--token', default=os.environ.get('GITHUB_TOKEN', ''))
    ap.add_argument('--repo', required=True)
    ap.add_argument('--user', default='')
    args = ap.parse_args()
    if not args.token:
        raise SystemExit('缺少 token：用 --token 传入或设置环境变量 GITHUB_TOKEN')
    SECRET.append(args.token)

    if not args.user:
        me = api('GET', '/user', args.token)
        args.user = me.get('login')
    print('账号: %s / 仓库: %s/%s' % (args.user, args.user, args.repo))

    if not os.path.isdir(REPO_DIR):
        raise SystemExit('找不到本地仓库目录: %s（请先跑 deploy_github.py 生成内容）' % REPO_DIR)

    files = [
        ('XianYuHelper/XianYuHelper.crx', os.path.join(REPO_DIR, 'XianYuHelper', 'XianYuHelper.crx')),
        ('XianYuHelper/update.xml', os.path.join(REPO_DIR, 'XianYuHelper', 'update.xml')),
        ('README.md', os.path.join(REPO_DIR, 'README.md')),
    ]
    for rel, local in files:
        if not os.path.isfile(local):
            print('  跳过（不存在）: %s' % rel)
            continue
        print('上传 %s (%.1f KB) …' % (rel, os.path.getsize(local) / 1024.0))
        r = push_file(args.token, args.user, args.repo, rel, local,
                      'chore: publish %s' % rel)
        print('  [--] 内容与线上一致，跳过' if (r or {}).get('skipped') else '  [OK] 已推送')

    print('-' * 60)
    print('推送完成，实际落库内容：')
    d = api('GET', '/repos/%s/%s/contents/XianYuHelper?ref=main' % (args.user, args.repo), args.token)
    for item in d if isinstance(d, list) else []:
        print('  %-20s %8d B' % (item.get('name'), item.get('size', 0)))


if __name__ == '__main__':
    main()
