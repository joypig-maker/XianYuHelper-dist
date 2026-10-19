# -*- coding: utf-8 -*-
"""
一键托管到 GitHub + jsDelivr（免费 HTTPS 分发源）。

做了什么：
  1. 用 GitHub API（需要 PAT）创建一个【公开】仓库
  2. 把 XianYuHelper.crx + update.xml（codebase 指向 jsDelivr）推上去
  3. jsDelivr 立刻以 HTTPS 提供这两个文件（CDN、正确 MIME，Chrome 强制安装友好）
  4. 回填 build_release.py 的 UPDATE_BASE_URL 并重新构建客户安装包

用法：
  python tools/deploy_github.py --token ghp_xxx --repo XianYuHelper-dist
  （--token 也可用环境变量 GITHUB_TOKEN；--repo 为仓库名，会被设为公开）

前置：本机需有 git（已在 PATH）。仓库建在 deploy/<repo>/。
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE = os.path.join(ROOT, 'dist', 'release')
CRX = os.path.join(RELEASE, 'XianYuHelper.crx')
_REDACT = []


def _redact(s):
    for t in _REDACT:
        if t:
            s = s.replace(t, '***')
    return s


def run(cmd, cwd=None, check=True):
    print('  $ ' + _redact(' '.join(cmd)))
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    if check and r.returncode != 0:
        print('  失败(stderr):', _redact((r.stderr or '').strip()[:500]))
        raise SystemExit('命令失败: ' + _redact(' '.join(cmd)))
    return r


def gh_api(method, path, token, data=None):
    import shutil
    curl = shutil.which('curl') or r'C:\WINDOWS\system32\curl.exe'
    url = 'https://api.github.com' + path
    cmd = [curl, '-sS', '-X', method, url,
           '-w', '\n%{http_code}',
           '-H', 'Authorization: Bearer ' + token,
           '-H', 'Accept: application/vnd.github+json',
           '-H', 'User-Agent: xy-ext-deploy']
    if data is not None:
        cmd += ['-H', 'Content-Type: application/json', '--data', json.dumps(data)]
    r = subprocess.run(cmd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError('curl 调用失败: ' + _redact(r.stderr[:400]))
    body, _, code = r.stdout.rstrip('\n').rpartition('\n')
    if not code.isdigit() or int(code) >= 400:
        raise RuntimeError('GitHub API %s %s -> HTTP %s: %s'
                           % (method, path, code, _redact(body.strip()[:300])))
    if not body.strip():
        return {}
    try:
        return json.loads(body)
    except Exception:
        raise RuntimeError('GitHub 返回非 JSON: ' + _redact(body[:400]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--token', default=os.environ.get('GITHUB_TOKEN', ''))
    ap.add_argument('--repo', required=True, help='GitHub 仓库名（将创建为公开仓库）')
    ap.add_argument('--user', default='', help='GitHub 用户名（留空则自动从 token 获取）')
    ap.add_argument('--branch', default='main')
    args = ap.parse_args()

    if not args.token:
        raise SystemExit('缺少 GitHub token：用 --token 传入或设置环境变量 GITHUB_TOKEN')
    _REDACT.append(args.token)

    if not os.path.isfile(CRX):
        raise SystemExit('找不到 %s，请先跑 build_release.py' % CRX)

    # 1) 取用户名（若未给）
    if not args.user:
        me = gh_api('GET', '/user', args.token)
        args.user = me.get('login')
        if not args.user:
            raise SystemExit('无法从 token 获取用户名：' + str(me))
    print('GitHub 账号: %s' % args.user)

    # 2) 创建公开仓库（已存在则跳过）
    try:
        gh_api('GET', '/repos/%s/%s' % (args.user, args.repo), args.token)
        print('仓库已存在，复用: %s/%s' % (args.user, args.repo))
    except Exception:
        print('创建公开仓库 %s/%s …' % (args.user, args.repo))
        gh_api('POST', '/user/repos', args.token,
               {'name': args.repo, 'private': False,
                'description': 'XianYuHelper 自托管分发源 (crx + update.xml)',
                'auto_init': False})

    base = 'https://cdn.jsdelivr.net/gh/%s/%s@%s/XianYuHelper' % (args.user, args.repo, args.branch)

    # 3) 准备本地仓库内容
    repo_dir = os.path.join(ROOT, 'deploy', args.repo)
    xydir = os.path.join(repo_dir, 'XianYuHelper')
    os.makedirs(xydir, exist_ok=True)
    shutil.copy2(CRX, os.path.join(xydir, 'XianYuHelper.crx'))
    xml = (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='jklmngkhcjklejabgchcjnbmjgpgmlcl'>\n"
        "    <updatecheck codebase='%s/XianYuHelper.crx' version='1.0.0' />\n"
        "  </app>\n"
        "</gupdate>\n"
    ) % base
    with open(os.path.join(xydir, 'update.xml'), 'w', encoding='utf-8') as f:
        f.write(xml)
    with open(os.path.join(repo_dir, 'README.md'), 'w', encoding='utf-8') as f:
        f.write('# XianYuHelper 分发源\n\n本仓库由部署脚本自动生成，仅供 Chrome/Edge 强制安装读取。\n'
                '实际插件为闭源，请勿在此仓库放源码。\n')

    # 4) git 初始化并推送（token 嵌入 remote URL）
    remote = 'https://%s:%s@github.com/%s/%s.git' % (args.user, args.token, args.user, args.repo)
    run(['git', 'init', '-b', args.branch], cwd=repo_dir, check=False)
    run(['git', 'config', 'user.email', 'xy-ext@example.com'], cwd=repo_dir, check=False)
    run(['git', 'config', 'user.name', 'XianYuHelper Deploy'], cwd=repo_dir, check=False)
    run(['git', 'remote', 'remove', 'origin'], cwd=repo_dir, check=False)
    run(['git', 'remote', 'add', 'origin', remote], cwd=repo_dir)
    run(['git', 'add', '-A'], cwd=repo_dir)
    run(['git', 'commit', '-m', 'chore: publish XianYuHelper crx + update.xml'], cwd=repo_dir, check=False)
    # 若 auto_init 已存在 main 且有初始提交，先 pull 再 push
    run(['git', 'pull', 'origin', args.branch, '--rebase', '--allow-unrelated-histories'],
        cwd=repo_dir, check=False)
    run(['git', 'push', '-u', 'origin', args.branch], cwd=repo_dir)

    # 5) 回填 UPDATE_BASE_URL 并重建
    br = os.path.join(ROOT, 'tools', 'build_release.py')
    s = open(br, encoding='utf-8').read()
    import re
    s2 = re.sub(r"UPDATE_BASE_URL = '[^']*'",
                "UPDATE_BASE_URL = '%s'" % base, s, count=1)
    open(br, 'w', encoding='utf-8').write(s2)
    print('已回填 UPDATE_BASE_URL = %s' % base)

    print('-' * 60)
    print('托管完成！客户可经以下地址强制安装：')
    print('  update.xml : %s/update.xml' % base)
    print('  crx       : %s/XianYuHelper.crx' % base)
    print('注意：jsDelivr 首次推送后可能有几分钟 CDN 缓存延迟，稍等再分发。')
    print('-' * 60)
    print('现在重新构建客户安装包…')
    run([sys.executable, 'tools/build_release.py'], cwd=ROOT)
    print('客户安装包：dist/闲鱼助手-安装包-v1.0.0.zip')


if __name__ == '__main__':
    main()
