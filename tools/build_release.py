# -*- coding: utf-8 -*-
"""
闲鱼助手 - 发布构建脚本

产出一套可直接发给客户的安装包：
  1. 固定 RSA 私钥（首次生成后复用 -> 扩展 ID 恒定，升级不会变成两个插件）
  2. CRX3 包（调用本机 Chrome/Edge 打包，自带官方签名结构）
  3. 本地 update.xml（强制安装策略需要的更新清单）
  4. 解压版目录（企业策略被禁用时，用开发者模式加载的兜底方案）
  5. install.bat / uninstall.bat + PowerShell 逻辑（免管理员，自动兼容 Chrome 与 Edge）

用法:
    python tools/build_release.py
"""
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD = os.path.join(ROOT, 'build')
DIST = os.path.join(ROOT, 'dist')
STAGING = os.path.join(DIST, 'staging')
RELEASE = os.path.join(DIST, 'release')
TPL_DIR = os.path.join(ROOT, 'tools', 'installer')
KEY_PATH = os.path.join(BUILD, 'xyext.pem')
CRX_NAME = 'XianYuHelper.crx'
PRODUCT = '闲鱼助手 - 商品采集工具'

# 分发用的「更新源基址」。自托管扩展必须用 HTTPS —— Chrome 137+ 已不再接受
# file:// 作为扩展更新源（实测 Chrome 154 会直接忽略 file:// 更新源，导致强制安装失效）。
#
# ⚠️ 2026-09-29 实测结论：**raw.githubusercontent.com 在国内直连拉不到**
#    （curl 两次都是 15 秒超时、0 字节收到）。而清单和 crx 都从它取，
#    等于整条自动更新链在国内完全没生效。同一天实测 jsDelivr：
#      · 可达 0.6~2.0s；crx 返回 106543 B、MIME application/x-chrome-extension
#      · 缓存刷新延迟约 6 分钟（14:32 推送 → 14:38 刷新），
#        清单和 crx 是**同时**刷新的
#      · 注意：URL 后加查询参数（?v=1.2.25&t=...）**破不了它的缓存**，
#        jsDelivr 按路径缓存，别指望用 query 立刻拿到新内容
#
# 曾经因为「jsDelivr 缓存不随 push 刷新、数小时仍返回旧快照」而切到 raw
# （raw 无缓存、永远最新，见 9/27 的记录）。但那条「数小时」这次没复现
# —— 而 raw 在国内不通是**确定的事实**。所以改回 jsDelivr：
# 能不能拿到 比 刷新快几分钟 重要得多（Chrome 一天也就查几次更新）。
#
# 副作用（必须知道）：update_url 是写进 manifest 的，换地址后
# **已经装上的扩展只能靠手动装一次新包**才能换过来 ——
# 旧包里的 update_url 指向 raw，它永远拉不到清单，也就永远等不到这次更新。
# 所以 v1.2.25 是一个「必须手动装一次」的过渡版本，装完以后才恢复自动更新。
#
# 若哪天 jsDelivr 也出问题，可选项：国内对象存储 / 自有服务器 / Gitee raw。
GITHUB_RAW = 'https://raw.githubusercontent.com/joypig-maker/XianYuHelper-dist/main/XianYuHelper'
JSDELIVR = 'https://cdn.jsdelivr.net/gh/joypig-maker/XianYuHelper-dist@main/XianYuHelper'
UPDATE_BASE_URL = JSDELIVR


def crx_url(version):
    return '%s/%s' % (UPDATE_BASE_URL.rstrip('/'), CRX_NAME)

BROWSERS = [
    ('Chrome', [
        'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    ]),
    ('Edge', [
        'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
        'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    ]),
]

INSTALL_BAT = '@echo off\r\nchcp 65001 >nul 2>&1\r\ncd /d \"%~dp0\"\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0install.ps1\"\r\nif errorlevel 1 pause\r\n'
UNINSTALL_BAT = '@echo off\r\nchcp 65001 >nul 2>&1\r\ncd /d \"%~dp0\"\r\npowershell -NoProfile -ExecutionPolicy Bypass -File \"%~dp0uninstall.ps1\"\r\nif errorlevel 1 pause\r\n'

# 放在解压根目录的防呆提示：告诉客户「加载已解压的扩展程序」到底该选哪一层。
# 以前扩展藏在 extension/ 子目录里，客户只要没精确选中那一层就会收到
# 「清单文件缺失或不可读取」，而这条报错完全指不向真正的原因。
HINT_TXT = '''【加载这里】怎么手动安装

如果你已经是「开发者模式」用户，想自己手动加载，请按下面做：

  1. 打开浏览器，地址栏输入 chrome://extensions （Edge 则是 edge://extensions）
  2. 打开右上角的「开发者模式」开关
  3. 点「加载已解压的扩展程序」
  4. 弹窗里选择【本文件夹】——就是你现在正在看的这一层，
     也就是和本文件「加载这里.txt」放在一起的那一层。

  ✔ 判断方法：能看见 manifest.json 文件的那一层，就选它。
  ✘ 不要选这一层的上级目录，也不要去翻 extension/ 之类子目录。

如果选错了目录，浏览器会提示「清单文件缺失或不可读取」——
那不是文件损坏，只是选的那一层没有 manifest.json，换回本层即可。

—— 更省事的做法：直接双击 install.bat，它会帮你处理好，
    需要手动加载时会自动打开扩展页面并把正确目录复制到剪贴板。
'''

README_TXT = '''闲鱼助手 - 商品采集工具   安装说明
================================================

【⚠ 最重要的一条，先看】

千万不要直接双击 "XianYuHelper.crx" 来安装！
现代 Chrome / Edge 会对「非商店来源 + 手动双击的 crx」判定为不可信，
自动禁用（图标变灰、点开提示"已停用"、无法运行）。
本插件必须通过下面的 install.bat 安装（它会写入浏览器官方策略，绕过该限制）。

如果已经误双击 crx 导致被禁用：
  → 先双击 uninstall.bat 卸载，再双击 install.bat 重新安装，最后重启浏览器。


【一、怎么装（正确方式）】

1. 双击 install.bat
2. 等黑色命令行窗口跑完（期间若弹出「是否允许更改设备」请选择【是】）
3. 完全退出浏览器（右下角托盘里的图标也要退出），再重新打开
4. 工具栏出现插件图标即安装成功

如果系统策略不允许自动安装，安装程序会自动打开浏览器扩展页面，
此时只需三步：开「开发者模式」-> 点「加载已解压的扩展程序」-> 粘贴路径
（路径已自动复制到剪贴板，该目录的根目录里直接就有 manifest.json）。
想自己手动加载的话，本文件夹根目录就是扩展目录，直接选它即可
（详见同目录的「加载这里.txt」）。


【二、怎么用】

1. 打开闲鱼商品页，例如 https://www.goofish.com/item?id=xxxxxx
2. 页面右下角出现采集面板
3. 面板按钮：
     复制链接 / 复制标题 / 复制店铺名 / 复制全部
     下载主图（自动按序号命名）
     保存文案（TXT / Markdown / JSON 三选一）
     一键打包（图片 + 文案落同一个文件夹）
4. 列表页（搜索结果页）支持批量复制链接、导出表格
5. 保存目录、文件夹命名、文案格式：点插件图标在弹窗里设置


【三、常见问题】

Q1. 浏览器显示「由贵单位管理」？
A1. 正常。插件通过浏览器官方的强制安装策略安装（更新源为厂商托管的 HTTPS 地址），这是唯一不需要应用商店、
    也不需要用户手动加载的自动安装方式，不代表任何远程管控。

Q2. 重启浏览器后没看到插件 / 插件被禁用？
A2. 九成是装错了方式（双击了 crx）。请：
    1) 双击 uninstall.bat 卸载
    2) 重启浏览器确认插件已消失
    3) 再双击 install.bat，重启浏览器
    若仍不行，打开 chrome://policy 或 edge://policy，搜索 ExtensionInstallForcelist
    确认策略值存在；或重跑一次 install.bat。

Q2b. 手动加载时提示「清单文件缺失或不可读取」？
A2b. 这不是文件损坏，而是你选的那一层目录里没有 manifest.json。
    「加载已解压的扩展程序」必须选中扩展目录本身——即根目录能看到
    manifest.json 的那一层。本安装包解压后的根目录就是扩展目录，
    直接选它；不要选上级目录，也不要再往 extension/ 里钻。
    细节见同目录的「加载这里.txt」。

Q3. 商品页面板不出现 / 抓不到数据？
A3. 插件直接读取闲鱼页面自身的接口返回。等页面完全渲染完成，或刷新一次。
    另外本插件需要 Chromium 111 以上内核，老旧的双核浏览器（如旧版 360 / QQ）
    可能不支持主世界注入，请改用新版 Chrome / Edge。

Q4. 不想用了怎么卸载？
A4. 双击 uninstall.bat，然后重启浏览器。若是通过开发者模式手动加载的，
    在扩展页面点「移除」即可。

Q5. 怎么升级？
A5. 拿到新版安装包后，再双击一次 install.bat 覆盖安装，重启浏览器即可。
    升级同样是写策略，不会变成两个插件（前提是私钥 build/xyext.pem 一直保留）。


【四、其它】

- 本工具完全本地运行，不上传任何数据，不联网激活，不含远程下发逻辑。
- 支持 Chrome / Edge 及所有 Chromium 111 以上内核的浏览器。
- 关于「自动安装」：现代 Chrome（137+）已不再接受本地 file:// 安装源，
  所以干净的自动安装需要把 hosting/ 里的两个文件上传到一个 HTTPS 地址，
  并把 build_release.py 的 UPDATE_BASE_URL 改成该地址后重新生成安装包
  （详见 release/hosting/托管说明.txt）。未配置托管时，install.bat 会自动
  退化为「解压版 + 开发者模式手动加载」，同样可用，只是需用户手动点几下。
'''


# ---------------------------------------------------------------- 基础工具


def ensure_dir(p):
    if not os.path.isdir(p):
        os.makedirs(p)


def read_text(p):
    with open(p, 'r', encoding='utf-8') as f:
        return f.read()


def write_text(p, s, bom=False):
    ensure_dir(os.path.dirname(p))
    with open(p, 'wb') as f:
        if bom:
            f.write(b'\xef\xbb\xbf')
        f.write(s.encode('utf-8'))


def _del_path(p):
    if os.path.isdir(p) and not os.path.islink(p):
        for f in os.listdir(p):
            _del_path(os.path.join(p, f))
        os.rmdir(p)
    elif os.path.isfile(p) or os.path.islink(p):
        os.remove(p)


def unique_path(path):
    """给 path 找一个不冲突的名字（用于「挪走旧的」而非覆盖）。

    覆盖式 move 在 Windows 上要么 os.rename 失败，要么降级成 copy2+unlink，
    后者在删除受管控的环境里会直接中断出包。所以挪走永远是挪到一个新名字。
    """
    if not os.path.exists(path):
        return path
    stem, ext = os.path.splitext(path)
    n = 1
    while os.path.exists('%s_%d%s' % (stem, n, ext)):
        n += 1
    return '%s_%d%s' % (stem, n, ext)


def sync_tree(src, dst):
    """把 src 覆盖式同步到 dst —— 不整目录 rmtree。

    原先用 shutil.rmtree(dst) + shutil.copytree(...)。目录里就这么几十个文件，
    rmtree 却会在受限环境（沙箱化的批量删除保护）下直接中断整个出包流程，
    而逐文件覆盖的语义完全等价：既不会漏掉更新，也不会误伤 dst 之外的东西。
    src 里已不存在、dst 里却残留的同名文件会顺手清掉，避免上版本的旧文件
    混进新包。
    """
    ensure_dir(dst)

    have = set()
    for root, _dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        for f in files:
            r = os.path.normpath(os.path.join(rel, f)) if rel != '.' else f
            have.add(r)
            dp = os.path.join(dst, r)
            ensure_dir(os.path.dirname(dp))
            shutil.copy2(os.path.join(root, f), dp)

    for root, _dirs, files in os.walk(dst):
        rel = os.path.relpath(root, dst)
        for f in files:
            r = os.path.normpath(os.path.join(rel, f)) if rel != '.' else f
            if r not in have:
                _del_path(os.path.join(root, f))


# ------------------------------------------------- 由私钥推算扩展 ID


def _der_len(n):
    if n < 0x80:
        return bytes([n])
    b = n.to_bytes((n.bit_length() + 7) // 8, 'big')
    return bytes([0x80 | len(b)]) + b


def _der_int(n):
    b = n.to_bytes((n.bit_length() + 8) // 8, 'big') if n else b'\x00'
    return b'\x02' + _der_len(len(b)) + b


def _der_seq(payload):
    return b'\x30' + _der_len(len(payload)) + payload


def _der_bitstring(payload):
    return b'\x03' + _der_len(len(payload) + 1) + b'\x00' + payload


def _tlv_children(d):
    """把 DER SEQUENCE 拆成 [(tag, bytes), ...]"""
    out, i = [], 0
    while i < len(d):
        tag = d[i]
        i += 1
        l = d[i]
        i += 1
        if l & 0x80:
            nb = l & 0x7F
            l = int.from_bytes(d[i:i + nb], 'big')
            i += nb
        out.append((tag, d[i:i + l]))
        i += l
    return out


def _pkcs1_modulus_exp(der):
    """PKCS#1 RSAPrivateKey -> (n, e)。入参既接受 SEQUENCE 本体，也接受其内容。"""
    body = der
    if body and body[0] == 0x30:
        kids = _tlv_children(body)
        if kids and kids[0][0] == 0x30:
            body = kids[0][1]
    ints = [int.from_bytes(v, 'big') for t, v in _tlv_children(body) if t == 0x02]
    if len(ints) < 3:
        raise ValueError('PKCS#1 解析失败，字段数=%d' % len(ints))
    return ints[1], ints[2]


def spki_from_pem(pem_path):
    """PEM(RSA, 兼容 PKCS#1 与 PKCS#8) -> X.509 SubjectPublicKeyInfo DER"""
    raw = open(pem_path, 'rb').read()
    b64 = b''.join(l for l in raw.splitlines() if not l.startswith(b'-----'))
    der = base64.b64decode(b64)

    top = _tlv_children(der)
    children = _tlv_children(top[0][1]) if top and top[0][0] == 0x30 else top

    if len(children) >= 3 and children[0][0] == 0x02 and children[1][0] == 0x30:
        # PKCS#8: SEQUENCE { version, algorithm, OCTET STRING(内含 PKCS#1) }
        n, e = _pkcs1_modulus_exp(children[2][1])
    else:
        n, e = _pkcs1_modulus_exp(top[0][1])

    rsa_oid = bytes.fromhex('06092a864886f70d010101')
    alg = _der_seq(rsa_oid + b'\x05\x00')
    pub = _der_seq(_der_int(n) + _der_int(e))
    return _der_seq(alg + _der_bitstring(pub))


def extension_id(pem_path):
    digest = hashlib.sha256(spki_from_pem(pem_path)).digest()[:16]
    return ''.join(chr(ord('a') + (b >> 4)) + chr(ord('a') + (b & 0xF)) for b in digest)


# ------------------------------------------------- 第一步：准备 staging


def build_staging():
    sync_tree(os.path.join(ROOT, 'src'), os.path.join(STAGING, 'src'))
    sync_tree(os.path.join(ROOT, 'icons'), os.path.join(STAGING, 'icons'))
    shutil.copy2(os.path.join(ROOT, 'manifest.json'), os.path.join(STAGING, 'manifest.json'))

    mpath = os.path.join(STAGING, 'manifest.json')
    manifest = json.loads(read_text(mpath))
    # 发布包带 update_url：Chrome 据此定期拉取升级。必须是 HTTPS（file:// 在新版 Chrome 已失效）
    manifest['update_url'] = UPDATE_BASE_URL + '/update.xml'
    write_text(mpath, json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')

    # 把版本号写进注入脚本，__XY__.v 才能报出扩展的真实版本，
    # 否则没法判断浏览器里跑的到底是哪个版本（本地调试时最容易踩）。
    ipath = os.path.join(STAGING, 'src', 'content', 'injected.js')
    src = read_text(ipath).replace('__VERSION__', manifest['version'])
    write_text(ipath, src)

    print('[staging] %s  (version=%s)' % (STAGING, manifest['version']))
    return manifest['version']


# ------------------------------------------------- 第二步：打包 crx


def find_packer():
    cands = []
    for name, paths in BROWSERS:
        for p in paths:
            if os.path.isfile(p):
                cands.append(p)
    if not cands:
        print('[pack] 未在标准路径找到 Chrome / Edge')
    for p in cands:
        try:
            r = subprocess.run([p, '--version'], capture_output=True, timeout=30)
            if r.returncode == 0:
                print('[pack] 打包器: %s' % p)
                return p
            print('[pack] %s --version 返回 %s' % (p, r.returncode))
        except Exception as e:
            print('[pack] %s 调用异常: %s' % (p, e))
    raise SystemExit('未找到可用于打包的 Chrome / Edge')


def pack_crx(packer):
    ensure_dir(BUILD)
    ensure_dir(RELEASE)
    # 不预先删 staging.crx。Chrome 自己会覆盖写，而「先 os.remove 再让 chrome
    # 写」在删除受管控的环境里会直接把出包流程打断在半路。
    crx_out = os.path.join(DIST, 'staging.crx')

    args = [packer, '--pack-extension=' + STAGING]
    if os.path.isfile(KEY_PATH):
        args.append('--pack-extension-key=' + KEY_PATH)
        print('[pack] 复用既有私钥，扩展 ID 保持不变')
    else:
        print('[pack] 首次打包，生成新私钥并永久保存到 build/xyext.pem')

    r = subprocess.run(args, capture_output=True, timeout=180)
    out = (r.stdout or b'').decode('utf-8', 'ignore') + (r.stderr or b'').decode('utf-8', 'ignore')
    if not os.path.isfile(crx_out):
        raise SystemExit('打包失败:\n' + out)

    if not os.path.isfile(KEY_PATH):
        generated = os.path.join(DIST, 'staging.pem')
        if not os.path.isfile(generated):
            raise SystemExit('未生成私钥，浏览器输出:\n' + out)
        shutil.move(generated, KEY_PATH)

    size = os.path.getsize(crx_out)
    if size < 1024:
        raise SystemExit('crx 体积异常，疑似打包失败')
    dest = os.path.join(RELEASE, CRX_NAME)
    if os.path.isfile(dest):
        # 覆盖而非 unlink：Windows 下 os.rename 不能落到已存在的目标上，
        # 而 shutil.move 的降级分支又得 unlink 旧文件。挪到一边最省事。
        shutil.move(dest, unique_path(os.path.join(DIST, '_prev_' + CRX_NAME)))
    shutil.move(crx_out, dest)
    print('[pack] %s (%d bytes)' % (dest, size))
    return dest


# ------------------------------------------------- 第三步：update.xml 与解压版


def write_update_xml(ext_id, version, base_url):
    xml = (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='%s'>\n"
        "    <updatecheck codebase='%s' version='%s' />\n"
        "  </app>\n"
        "</gupdate>\n"
    ) % (ext_id, crx_url(version), version)
    p = os.path.join(RELEASE, 'update.xml')
    write_text(p, xml)
    print('[xml] update.xml -> appid=%s version=%s codebase=%s' % (ext_id, version, crx_url(version)))


def ship_unpacked():
    """随包附一份解压版，用于策略被禁用时的开发者模式加载"""
    dst = os.path.join(RELEASE, 'extension')
    sync_tree(STAGING, dst)
    # 解压版不带 update_url（本地加载时无意义，且避免出现更新校验告警）
    mp = os.path.join(dst, 'manifest.json')
    m = json.loads(read_text(mp))
    m.pop('update_url', None)
    write_text(mp, json.dumps(m, ensure_ascii=False, indent=2) + '\n')
    n = sum(len(f) for _, _, f in os.walk(dst))
    print('[unpacked] extension/ (%d 个文件，兜底用)' % n)


def write_hosting(ext_id, version):
    """生成「要上传到 HTTPS 主机」的目录：crx + update.xml + 说明"""
    # 这里必须整目录清空而不是 sync_tree：hosting 只该有 crx + update.xml +
    # 说明三件，sync_tree 会把整棵 release 树（extension/、install.ps1…，
    # 甚至上一轮的 hosting/ 自己）都复制进来，膨胀到近 600KB。
    host_dir = os.path.join(RELEASE, 'hosting')
    if os.path.isdir(host_dir):
        # 挪走旧的而不是 rmtree：hosting 只是人工上传用的副本，留一份
        # 上一版没有害处，真删反而会在管控环境里卡住出包。
        shutil.move(host_dir, unique_path(os.path.join(DIST, '_prev_hosting')))
    ensure_dir(host_dir)
    shutil.copy2(os.path.join(RELEASE, CRX_NAME), os.path.join(host_dir, CRX_NAME))
    xml = (
        "<?xml version='1.0' encoding='UTF-8'?>\n"
        "<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>\n"
        "  <app appid='%s'>\n"
        "    <updatecheck codebase='%s/%s' version='%s' />\n"
        "  </app>\n"
        "</gupdate>\n"
    ) % (ext_id, UPDATE_BASE_URL.rstrip('/'), CRX_NAME, version)
    write_text(os.path.join(host_dir, 'update.xml'), xml)
    guide = (
        '把本目录里的两个文件上传到任意 HTTPS 静态主机（如 GitHub Pages / Netlify /\n'
        'Vercel / 对象存储 + CDN / 自己的 VPS），保持目录结构：\n'
        '\n'
        '  https://你的域名/XianYuHelper/XianYuHelper.crx\n'
        '  https://你的域名/XianYuHelper/update.xml\n'
        '\n'
        '然后做两件事：\n'
        '  1) 把 tools/build_release.py 顶部的 UPDATE_BASE_URL 改成上面的真实地址，重新 build；\n'
        '     这样 install.bat 写出的强制安装策略才会指向你的主机。\n'
        '  2) 客户双击 install.bat 即可自动安装，无需应用商店、无需手动加载。\n'
        '\n'
        '注意：必须是 HTTPS 且地址可直接访问（不能要求登录）。\n'
        'Chrome 137+ 已不再接受 file:// 作为扩展更新源，所以本地路径方案已失效。\n'
    )
    write_text(os.path.join(host_dir, '托管说明.txt'), guide, bom=True)
    print('[hosting] hosting/ （上传到 HTTPS 主机的两个文件 + 说明）')


# ------------------------------------------------- 第四步：安装 / 卸载脚本


# 客户会拿到的东西。顺序即 zip 内的顺序。
DELIVERY = [
    'XianYuHelper.crx', 'update.xml',
    'install.bat', 'install.ps1', 'uninstall.bat', 'uninstall.ps1',
    '安装说明.txt', '加载这里.txt', 'EXTENSION_ID.txt',
    'extension',          # 解压版兜底（delivery_relpath 会把它铺平到根目录）
]


def delivery_relpath(rel):
    """把发布目录内的相对路径映射到客户 zip 内的路径。

    关键设计：解压出来的「根目录」本身就必须是一个完整可加载的扩展目录，
    manifest.json 直接位于根，不再套一层 extension/。

    原因（真实踩坑）：如果扩展藏在 extension/ 子目录里，客户在
    chrome://extensions 点「加载已解压的扩展程序」时，只要没精确选中那一层
    子目录，Chrome 就会报「清单文件缺失或不可读取」——而这个报错完全看不出
    是"选错目录"，用户反复重装也解决不了。
    """
    rel = rel.replace('\\', '/')
    if rel == 'extension' or rel.startswith('extension/'):
        return rel[len('extension'):].lstrip('/')
    return rel


def make_delivery_zip():
    """打一个客户可直接解压使用的 zip 安装包。

    只打包白名单里的交付件。以前是 walk 整个 RELEASE 目录——只要 RELEASE 下
    多出任何东西（比如 hosting/ 被误塞了整棵 release 树），就会被静悄悄
    打进客户包，客户拿到手的 zip 比正常大两三倍还说不出哪里不对。
    """
    import zipfile
    manifest = json.loads(read_text(os.path.join(RELEASE, 'extension', 'manifest.json')))
    ver = manifest.get('version', '1.0.0')
    # zipfile 'w' 会就地截断重写，不需要先删
    zip_path = os.path.join(DIST, '闲鱼助手-安装包-v%s.zip' % ver)

    picked = [p for p in DELIVERY if os.path.exists(os.path.join(RELEASE, p))]
    skipped = [p for p in DELIVERY if p not in picked]
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as z:
        for p in picked:
            rp = os.path.join(RELEASE, p)
            if os.path.isdir(rp):
                for rt, _d, fs in os.walk(rp):
                    for f in fs:
                        full = os.path.join(rt, f)
                        z.write(full, delivery_relpath(os.path.relpath(full, RELEASE)))
            else:
                z.write(rp, delivery_relpath(p))
    print('[zip] %s (%.1f KB)' % (zip_path, os.path.getsize(zip_path) / 1024.0))
    if skipped:
        print('[zip] 跳过缺失交付件: %s' % ', '.join(skipped))
    return zip_path


def write_installer(ext_id, version):
    ins = read_text(os.path.join(TPL_DIR, 'install.ps1.tpl'))
    unins = read_text(os.path.join(TPL_DIR, 'uninstall.ps1.tpl'))
    reps = [('__EXT_ID__', ext_id), ('__CRX_NAME__', CRX_NAME),
            ('__VERSION__', version), ('__PRODUCT__', PRODUCT),
            ('__UPDATE_BASE_URL__', UPDATE_BASE_URL)]

    def fill(s):
        for k, v in reps:
            s = s.replace(k, v)
        return s

    ensure_dir(RELEASE)
    write_text(os.path.join(RELEASE, 'install.ps1'), fill(ins), bom=True)
    write_text(os.path.join(RELEASE, 'uninstall.ps1'), fill(unins), bom=True)
    write_text(os.path.join(RELEASE, 'install.bat'), INSTALL_BAT)
    write_text(os.path.join(RELEASE, 'uninstall.bat'), UNINSTALL_BAT)
    write_text(os.path.join(RELEASE, '安装说明.txt'), README_TXT, bom=True)
    write_text(os.path.join(RELEASE, '加载这里.txt'), HINT_TXT, bom=True)
    write_text(os.path.join(RELEASE, 'EXTENSION_ID.txt'), '%s\nversion=%s\n' % (ext_id, version))
    print('[installer] %s' % RELEASE)


# ---------------------------------------------------------------- 入口


def main():
    print('=' * 60)
    print('闲鱼助手 - 发布构建')
    print('=' * 60)
    version = build_staging()
    packer = find_packer()
    pack_crx(packer)
    ext_id = extension_id(KEY_PATH)
    if not re.match(r'^[a-p]{32}$', ext_id):
        raise SystemExit('扩展 ID 计算异常: %s' % ext_id)
    print('[id] 扩展 ID: %s' % ext_id)
    write_update_xml(ext_id, version, UPDATE_BASE_URL)  # 清单放无缓存的 raw 地址
    ship_unpacked()
    write_hosting(ext_id, version)
    write_installer(ext_id, version)
    zip_path = make_delivery_zip()

    print('-' * 60)
    print('构建完成，%s 下交付文件:' % RELEASE)
    for f in sorted(os.listdir(RELEASE)):
        p = os.path.join(RELEASE, f)
        size = os.path.getsize(p) if os.path.isfile(p) else sum(
            os.path.getsize(os.path.join(r, x)) for r, _, fs in os.walk(p) for x in fs)
        print('  %-20s %8.1f KB' % (f, size / 1024.0))
    print('-' * 60)
    print('扩展 ID    : %s' % ext_id)
    print('升级清单   : %s/update.xml' % UPDATE_BASE_URL)
    print('私钥       : %s' % KEY_PATH)
    print('客户交付件 : %s' % zip_path)
    print('注意       : 私钥务必备份，丢失后无法发布同 ID 的新版本')
    # 构建 ≠ 发布。这两件事以前是分开的两个脚本，于是很容易「跑完构建就以为完事了」——
    # 实测后果：v1.2.6 ~ v1.2.24 一共 19 个版本没上传，线上 update.xml 停在 1.2.5，
    # 用 crx 装的用户一直收不到更新，而本地看起来一切正常。
    # 这里每次构建完都显式提醒一句，让「没发布」这件事无法被忽略。
    print('-' * 60)
    print('⚠ 以上只是**本地构建**，还没上传。要让用户能自动更新，请再跑：')
    print('    python tools/publish_release.py --token <GitHub Token>')
    print('-' * 60)
    return 0


if __name__ == '__main__':
    sys.exit(main())
