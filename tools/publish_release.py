# -*- coding: utf-8 -*-
"""
一键发布：把**当前构建产物**同步到分发仓库目录，再用 GitHub Contents API 推上去。

为什么需要这一步（而不是直接跑 upload_via_api.py）：
  upload_via_api.py 读的是 deploy/XianYuHelper-dist/ 下的文件，
  **它自己不会去 dist/release 取最新的**。
  于是「跑完 build_release.py 就以为发布完了」—— 推上去的还是上次留在那个目录里的旧包。
  实测后果：v1.2.6 ~ v1.2.24 一直没上传，线上 update.xml 停在 1.2.5，
  而本地早就到 1.2.24 了，两边差了 19 个版本。

同时会**校验版本号**，这是另一个容易静默出错的地方：
  deploy_github.py 里那份 update.xml 的 version 是**硬编码 '1.0.0'** 的。
  谁要是用它发布，线上就写成 version='1.0.0'，Chrome 认为没有更新，
  自动更新链路直接失效 —— 而且不报任何错。
  所以这里强制拿 build_release.py 产出的那份，并要求它和 manifest.json 一致。

用法：
  # 只准备好待发布内容（不上传），看会推什么
  python tools/publish_release.py

  # 真发布
  python tools/publish_release.py --token ghp_xxx
  （token 也可用环境变量 GITHUB_TOKEN；需要 repo 的 contents 写权限）
"""
import argparse
import io
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RELEASE = os.path.join(ROOT, 'dist', 'release')
CRX_SRC = os.path.join(RELEASE, 'XianYuHelper.crx')
XML_SRC = os.path.join(RELEASE, 'update.xml')
REPO_DIR = os.path.join(ROOT, 'deploy', 'XianYuHelper-dist')
DST = os.path.join(REPO_DIR, 'XianYuHelper')


def read(p, mode='r'):
    if 'b' in mode:
        with open(p, mode) as f:
            return f.read()
    with io.open(p, mode, encoding='utf-8') as f:
        return f.read()


def write(p, s, mode='w'):
    if 'b' in mode:
        with open(p, mode) as f:
            f.write(s)
        return
    with io.open(p, mode, encoding='utf-8', newline='') as f:
        f.write(s)


def version_of(path):
    """从 update.xml 里抠版本号。

    必须锚定 <updatecheck> 节点 —— 文件的**第一行就是 XML 声明**
    `<?xml version='1.0' ...?>`，直接 find("version='") 抓到的永远是那个 1.0，
    于是校验会把一份完全正常的 update.xml 判成「版本不对」。
    """
    s = read(path)
    i = s.find('updatecheck')
    if i < 0:
        return ''
    j = s.find("version='", i)
    if j < 0:
        return ''
    k = s.find("'", j + 9)
    return s[j + 9:k]


def online_version(repo, user):
    """读线上 update.xml 的版本（公开仓库，不需要 token）"""
    # 带个时间戳参数：Contents API 有 60 秒缓存，刚推完立刻回读会拿到旧值，
    # 于是「发布成功」被误报成「线上版本与预期不符」。
    url = ('https://api.github.com/repos/%s/%s/contents/XianYuHelper/update.xml?t=%d'
           % (user, repo, int(__import__('time').time())))
    r = subprocess.run(['curl', '-sS', '--max-time', '25', url],
                       capture_output=True, text=True)
    try:
        j = json.loads(r.stdout or '{}')
        if j.get('content'):
            import base64
            s = base64.b64decode(j['content']).decode('utf-8')
            # 同样要跳过第一行的 XML 声明（那里的 version='1.0' 不是版本号）
            i = s.find('updatecheck')
            k = s.find("version='", i) if i >= 0 else -1
            return s[k + 9:s.find("'", k + 9)] if k >= 0 else '(读不到)'
    except Exception:
        pass
    return '(查询失败)'


def saved_token():
    """从分发仓库的 git remote URL 里取 token。

    本机一直拿这个当凭据来源：deploy_github.py 当年把 token 嵌进 remote
    （https://user:token@github.com/...），之后没清过。
    """
    cfg = os.path.join(REPO_DIR, '.git', 'config')
    if not os.path.isfile(cfg):
        return ''
    m = re.search(r'https://[^:@/\s]+:([^@\s]+)@github\.com', read(cfg))
    return m.group(1) if m else ''


def resolve_token(explicit):
    """按 命令行 → 环境变量 → 本机已存 的顺序找 token，并说明来源（不打印 token 本身）"""
    if explicit:
        return explicit, '命令行 --token'
    env = os.environ.get('GITHUB_TOKEN') or os.environ.get('GH_TOKEN') or ''
    if env:
        return env, '环境变量 GITHUB_TOKEN'
    saved = saved_token()
    if saved:
        return saved, '分发仓库 .git/config（本机已存）'
    return '', ''


def check_token(token):
    """上传前先验一次。本机存着两个 token，其中一个是 401 的 —— 不验就会一头雾水。"""
    r = subprocess.run(['curl', '-sS', '--max-time', '20',
                        '-H', 'Authorization: Bearer ' + token,
                        '-H', 'User-Agent: xy-ext-deploy',
                        'https://api.github.com/user'],
                       capture_output=True, text=True)
    try:
        j = json.loads(r.stdout or '{}')
        if j.get('login'):
            return j['login'], ''
        return '', str(j.get('message') or '未知错误')
    except Exception:
        return '', (r.stdout or r.stderr or '')[:140]


def jsdelivr_base():
    """从 build_release.py 里抠出 jsDelivr 基址；不是 jsDelivr 就返回 ''。

    UPDATE_BASE_URL 可能直接写字符串，也可能引用 JSDELIVR 变量（现在是后者），
    两种情况都认。
    """
    s = read(os.path.join(ROOT, 'tools', 'build_release.py'))
    m = re.search(r'^UPDATE_BASE_URL\s*=\s*(\S+)', s, re.M)
    if not m:
        return ''
    val = m.group(1).strip().strip("'\"")
    if val.startswith('http'):
        return val if 'jsdelivr' in val.lower() else ''
    v = re.search(r'^%s\s*=\s*[\'"]([^\'"]+)[\'"]' % re.escape(val), s, re.M)
    if v and 'jsdelivr' in v.group(1).lower():
        return v.group(1)
    return ''


def purge_jsdelivr(retries=3):
    """主动清 jsDelivr 缓存。

    不主动清的话缓存刷新时间**不可控**：实测 v1.2.25 是 6 分钟，
    而 v1.2.26 等了 9 分钟还没动 —— 发版等于延迟生效，用户点「更新」拿不到。
    jsDelivr 官方提供 purge 接口（把域名换成 purge.jsdelivr.net，路径不变），
    实测清完 **8 秒**就能读到新内容。

    要重试：实测偶发 `curl: (35) Recv failure: Connection was reset`，
    一次失败就放弃的话，CDN 会停留在旧版本（用户拿不到更新）而脚本还报成功。

    连续清会被限流：第二次连跑时返回 `"throttled": true, "throttlingReset": 3470`
    —— 状态仍是 finished，但**未必真清了**。所以 main 里最后一定要用
    cdn_version() 实测一遍 CDN 上的版本，别只信 purge 的返回值。

    回读必须 --noproxy '*'：本机设了 HTTP_PROXY，而**代理自己也有缓存**，
    走代理读会拿到旧内容，让人误判 purge 没生效（这个坑今天踩过）。
    """
    base = jsdelivr_base()
    if not base:
        print('  当前更新源不是 jsDelivr，跳过 purge')
        return True
    pbase = base.replace('cdn.jsdelivr.net', 'purge.jsdelivr.net').rstrip('/')
    all_ok = True
    for f in ('update.xml', os.path.basename(CRX_SRC)):
        detail = ''
        ok = False
        for attempt in range(1, retries + 1):
            r = subprocess.run(['curl', '-sS', '--noproxy', '*', '--max-time', '30',
                                pbase + '/' + f], capture_output=True, text=True)
            detail = (r.stdout or r.stderr or '').strip()
            try:
                j = json.loads(detail)
                k = list((j.get('paths') or {}).keys())
                st = (j.get('paths') or {}).get(k[0]) if k else None
                detail = 'status=' + str(j.get('status')) + ' ' + json.dumps(st)
            except Exception:
                detail = detail[:150]
            if 'finished' in detail:
                ok = True
                break
            if attempt < retries:
                time.sleep(2)
        print('  purge %-18s : %s%s' % (f, detail,
              '' if ok else '   ✗ 试了 %d 次仍失败' % retries))
        if not ok:
            all_ok = False
    return all_ok


def cdn_version():
    """读 jsDelivr 上清单的版本（直连！见 purge_jsdelivr 里的说明）"""
    base = jsdelivr_base()
    if not base:
        return '(非 jsDelivr)'
    r = subprocess.run(['curl', '-sS', '--noproxy', '*', '--max-time', '20',
                        base.rstrip('/') + '/update.xml'], capture_output=True, text=True)
    s = r.stdout or ''
    i = s.find('updatecheck')
    k = s.find("version='", i) if i >= 0 else -1
    return s[k + 9:s.find("'", k + 9)] if k >= 0 else '(读不到)'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--token', default='',
                    help='GitHub Token；不给则依次找 环境变量 / 分发仓库 .git/config')
    ap.add_argument('--repo', default='XianYuHelper-dist')
    ap.add_argument('--user', default='joypig-maker')
    ap.add_argument('--no-upload', action='store_true', help='只做本地准备，不上传')
    args = ap.parse_args()

    print('=' * 62)
    print('发布前检查')
    print('=' * 62)

    if not os.path.isfile(CRX_SRC):
        raise SystemExit('找不到 %s —— 先跑 python tools/build_release.py' % CRX_SRC)
    if not os.path.isfile(XML_SRC):
        raise SystemExit('找不到 %s —— 先跑 python tools/build_release.py' % XML_SRC)

    mf = json.loads(read(os.path.join(ROOT, 'manifest.json')))
    v_manifest = mf.get('version', '')
    v_xml = version_of(XML_SRC)
    v_ext = ''
    ext_mf = os.path.join(RELEASE, 'extension', 'manifest.json')
    if os.path.isfile(ext_mf):
        v_ext = json.loads(read(ext_mf)).get('version', '')

    print('  源码 manifest.json : %s' % v_manifest)
    print('  打包后 extension   : %s' % (v_ext or '(缺)'))
    print('  update.xml 版本    : %s' % v_xml)
    print('  crx 大小           : %.1f KB' % (os.path.getsize(CRX_SRC) / 1024.0))

    bad = False
    if not v_manifest:
        print('  ✗ manifest.json 没读到版本号')
        bad = True
    if v_ext and v_ext != v_manifest:
        print('  ✗ 打包产物版本(%s) 与源码(%s) 不一致 —— 产物是旧的，重新构建' % (v_ext, v_manifest))
        bad = True
    if v_xml != v_manifest:
        print('  ✗ update.xml 里的版本(%s) 与 manifest(%s) 不一致 —— '
              '拿错文件了（deploy_github.py 那份是硬编码 1.0.0）' % (v_xml, v_manifest))
        bad = True
    if bad:
        raise SystemExit('检查未通过，先修好再发布')

    print('  线上当前版本       : %s' % online_version(args.repo, args.user))

    token, src = resolve_token(args.token)
    if token:
        login, err = check_token(token)
        if login:
            print('  token 来源         : %s' % src)
            print('  token 校验         : ✓ 账号 %s' % login)
        else:
            print('  token 来源         : %s' % src)
            print('  ✗ token 无效：%s' % err)
            print('    换一个有效的（github.com/settings/tokens，需要该仓库 contents 写权限）')
            return 3
    else:
        print('  token              : 未找到（只做本地准备）')
    print('  ✓ 校验通过，待发布版本 %s' % v_manifest)

    # ---- 同步到分发仓库目录 ----
    os.makedirs(DST, exist_ok=True)
    write(os.path.join(DST, 'XianYuHelper.crx'), read(CRX_SRC, 'rb'), 'wb')
    write(os.path.join(DST, 'update.xml'), read(XML_SRC))
    print('\n已同步到 %s' % DST)
    print('  XianYuHelper.crx  %.1f KB' % (os.path.getsize(os.path.join(DST, 'XianYuHelper.crx')) / 1024.0))
    print('  update.xml        version=%s' % version_of(os.path.join(DST, 'update.xml')))

    if not token or args.no_upload:
        print('\n' + '-' * 62)
        print('只做了本地准备（没有上传）。')
        if not token:
            print('没找到可用的 token。可以显式传入：')
            print('  python tools/publish_release.py --token <你的 GitHub Token>')
        else:
            print('你指定了 --no-upload。去掉它即可真正发布。')
        print('-' * 62)
        return 0

    print('\n开始上传…')
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'tools', 'upload_via_api.py'),
                        '--token', token, '--repo', args.repo, '--user', args.user],
                       cwd=ROOT)
    if r.returncode != 0:
        raise SystemExit('上传失败（看上面输出）')

    print('\n清 CDN 缓存…')
    if not purge_jsdelivr():
        print('  （purge 没全成功。若下面 CDN 版本不是 %s，重跑一次本脚本即可）' % v_manifest)

    print('\n' + '=' * 62)
    after = online_version(args.repo, args.user)      # GitHub 仓库里的
    cdn = cdn_version()                               # CDN 上的（直连读）
    print('GitHub 仓库版本 : %s' % after)
    print('jsDelivr 版本   : %s' % cdn)
    if after == v_manifest and cdn == v_manifest:
        print('✓ 发布成功且已生效：%s —— 用户现在点「更新」就能拿到' % v_manifest)
    elif after == v_manifest:
        print('⚠ 已上传，但 CDN 还没刷新（当前 %s）。稍等一会，或重跑一次本脚本触发 purge。' % cdn)
        return 4
    else:
        print('⚠ 仓库里的版本是 %s，与预期不符 —— 检查上传是否真的成功' % after)
        return 4
    print('=' * 62)
    return 0


if __name__ == '__main__':
    sys.exit(main())
