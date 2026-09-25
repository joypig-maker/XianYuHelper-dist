# 多站点商品采集助手（闲鱼 / 1688）

对标「店透视」的商品采集插件：在商品页/列表页一键**复制链接 / 标题 / 店铺名**，批量**下载主图**、把**文案保存到电脑**。

支持 **闲鱼**、**1688**（搜索列表页 + 店铺全店商品页）。

Chrome / Edge 等 Chromium 内核浏览器，Manifest V3。

---

## 一、功能

| 功能 | 说明 |
| --- | --- |
**列表页（首页 / 搜索结果）**

| 功能 | 说明 |
| --- | --- |
| 页面内勾选 | 每个商品卡片左上角出现圆形复选框，直接勾选要下载的商品，**不必点进详情页** |
| 滚动自动累积 | 向下滚动持续加载时，新出现的商品自动纳入识别，滚动多少就识别多少，按 itemId 去重 |
| 批量下载主图 | 勾选若干个后一次性下载，每个商品各自一个文件夹 |
| 批量保存文案 | 同上，批量落盘 TXT / Markdown / JSON |
| 批量一键打包 | 勾选项的文案 + 主图一起下载 |
| 全选 / 全不选 / 反选 | 面板内一键处理整页 |
| 自动补齐详情 | 勾选后自动回查接口补回描述与主图列表（列表接口只给标题/价格/缩略图） |
| 剔除卖家头像 | 头像、logo、图标等非商品图不会进下载包 |
| 导出 / 复制链接 | 复制全部链接、复制「标题+链接」、导出商品列表 |

**商品详情页**

| 功能 | 说明 |
| --- | --- |
| 复制链接 | 输出 `https://www.goofish.com/item?id=xxx` 标准链接（自动去掉跟踪参数） |
| 复制标题 | 商品标题 |
| 复制店铺名 | 卖家昵称 |
| 复制全部 | 标题＋价格＋店铺＋链接＋商品描述，一次性进剪贴板 |
| 下载主图 | 一次下载详情页所有主图，自动按商品建文件夹、按序号命名 |
| 保存文案 | 标题/价格/店铺/描述/图片地址 保存为 TXT、Markdown 或 JSON |
| 一键打包 | 文案 + 全部主图下载到同一个文件夹 |
| 悬浮面板 | 右下角常驻操作面板，可拖动、可收起 |

保存结构示例：

```
下载/闲鱼采集/小王数码严选_出一台 iPhone 15 128G_1054899470781/
├── 文案.txt
├── 主图_1.jpg
├── 主图_2.jpg
└── 主图_3.jpg
```

文件夹命名模板可改，支持变量：`{shop}` `{title}` `{itemId}` `{price}` `{date}`。

---

## 二、安装

### 自用 / 调试：开发者模式加载

1. 打开 Chrome，地址栏输入 `chrome://extensions/` 回车
2. 右上角打开 **开发者模式**
3. 点击 **加载已解压的扩展程序**，选择本目录 `D:\work\闲鱼浏览器插件`
4. 打开任意闲鱼商品页（如 `https://www.goofish.com/item?id=xxx`），右下角会出现「闲鱼助手」面板

> 每次修改代码后，在扩展页点一下该插件的「刷新」按钮，再刷新闲鱼页面即可生效。

> ⚠️ **「加载已解压的扩展程序」必须选中扩展目录本身**——即根目录能看到 `manifest.json` 的那一层。
> 选错一层（比如选了包含 `install.bat` 的父目录）浏览器只会报「清单文件缺失或不可读取」，
> 而这个文件其实好好地躺在子目录里，极易误判成文件损坏。
> 本项目自 v1.1.1 起，交付 zip 解压后的根目录就是扩展目录，直接选它即可。
> 发版前务必跑 `python tools/verify_unpacked.py dist/闲鱼助手-安装包-v*.zip` 做结构校验。

### 分发给客户：一键安装包

**先说红线**：Chrome 从 2022 年起禁止双击 `.crx` 安装；更关键的是，**Chrome 137+ 已不再接受 `file://` 作为扩展更新源**（实测 Chrome 154 会直接忽略本地更新清单，导致强制安装失效）。所以**千万不要把 `.crx` 直接发给客户双击**——那一定被浏览器判定为「非商店来源」并自动禁用（`DISABLE_NOT_VERIFIED`）。

正确分发只有两条路：

**路线 A（推荐，干净自动安装）——HTTPS 自托管 + 策略**

把两个文件上传到任意 HTTPS 静态主机（GitHub Pages / Netlify / 对象存储+CDN / 自己的 VPS）：

```
dist/release/hosting/XianYuHelper.crx
dist/release/hosting/update.xml
```

然后把 `tools/build_release.py` 顶部的 `UPDATE_BASE_URL` 改成真实地址（如 `https://你的域名/XianYuHelper`）重新构建。之后客户解压双击 `install.bat`，安装器写入 `ExtensionInstallForcelist` 策略，浏览器重启后自动装上，**无需应用商店、无需开发者模式**。

```bash
python tools/build_release.py     # 构建：crx + update.xml + 安装器 + 客户 zip + hosting/
python tools/verify_package.py    # 校验包结构、签名 ID、update.xml 三处对齐
python tools/verify_distribute.py # 任意客户机上体检：插件是否被禁用、是否走了策略
```

**零成本实操：GitHub 公开仓库托管（已部署，v1.1.0）**

不想自己搭服务器，用 GitHub 公开仓库托管即可（HTTPS，无需应用商店）。当前已在线：

```
更新清单 update.xml : https://raw.githubusercontent.com/joypig-maker/XianYuHelper-dist/main/XianYuHelper/update.xml
升级包   crx        : https://raw.githubusercontent.com/joypig-maker/XianYuHelper-dist/main/XianYuHelper/XianYuHelper.crx
```

> **为什么用 `raw.githubusercontent.com` 而不是 jsDelivr？** 这是个踩过的坑：
> jsDelivr 对 GitHub 内容的缓存**不会随 push 刷新**——重建 tag 后访问 `@v1.1.0` 拿到的仍是旧快照，
> `@main` 更是长时间返回上一个版本。结果就是明明推送成功，客户那边却怎么都升级不到新版。
> raw 源没有 CDN 缓存、永远等于仓库当前内容，发版即刻生效。
> （Chrome 的更新检查按 XML 解析清单，不校验 `Content-Type`，`raw` 的 `text/plain` 不影响；
> crx 是二进制下载，MIME 无所谓。）

发版一条龙：

```bash
# 1) 改完代码，把 manifest.json 的 version 抬到新号，然后：
python tools/build_release.py                                  # 打 crx + 客户 zip + 安装器
# 2) 推到 GitHub（Contents API，绕开本机 git 代理问题）
python tools/upload_via_api.py --repo XianYuHelper-dist --user joypig-maker
# 3) 校验
python tools/verify_package.py
node tools/validate.js && node tools/test-util.js && node tools/test-batch.js
```

> 若本机 git 走代理会出现 `schannel: server closed abruptly` / `502`，此时直接用 `upload_via_api.py`（GitHub Contents API）绕过 git 推送；文件已存在时脚本会自动带 `sha` 更新，可重复执行。
> 仓库必须保持**公开**，否则取不到文件。
> GitHub token 用环境变量 `GITHUB_TOKEN` 传入，命令行与日志均会脱敏。

**路线 B（零托管，手动兜底）——解压版 + 开发者模式**

若你暂时不想搭主机，`install.bat` 在未配置 HTTPS 地址时会自动退化为：把解压版复制到本地目录、打开浏览器扩展页、路径进剪贴板，客户只需「开开发者模式 → 加载已解压的扩展程序 → 粘贴路径」三步。这条路**所有 Chrome/Edge 都能用**，缺点是会显示「开发者模式扩展」提示条。

> 安装器仍保留「HKCU 策略 → 申请管理员写 HKLM」的二级降级；但若 `UPDATE_BASE_URL` 未配置 HTTPS，会直接走路线 B，
> 不再尝试无效的 `file://` 策略。

卸载：双击 `uninstall.bat`。

**发布注意**：`build/xyext.pem` 是签名私钥，决定了扩展 ID（`jklmngkhcjklejabgchcjnbmjgpgmlcl`）。**务必备份**——丢失后再打包会生成新 ID，客户端会变成两个不同插件，无法平滑升级。升级发布时改 `manifest.json` 的 version 后重新构建即可。

---

## 三、目录结构

```
闲鱼浏览器插件/
├── manifest.json                    # MV3 清单
├── icons/                           # 图标（tools/gen_icons.py 生成）
├── src/
│   ├── common/
│   │   ├── sites.js                 # 站点适配表：ID 正则、选择器、接口配置（加站点只改这里）
│   │   └── util.js                  # 公共工具：字段提取、URL 清洗、文案/文件名生成
│   ├── content/
│   │   ├── injected.js              # MAIN world：拦截接口 + DOM 解析（数据来源）
│   │   ├── bridge.js                # ISOLATED world：悬浮面板 UI + 复制 + 与后台通信
│   │   └── panel.css                # 面板样式
│   ├── background/service_worker.js # 下载落盘：图片、文案、目录组织
│   └── popup/                       # 插件弹窗：预览 + 快捷操作 + 设置
└── tools/
    ├── gen_icons.py                 # 生成图标
    ├── test-util.js                 # 数据提取自测
    ├── test-sites.js                # 站点适配层自测（含模拟页面扫描）
    └── pack.py                      # 打包 zip
```

---

## 四、数据是怎么拿到的（核心原理）

闲鱼 PC 端是 ICE + React 的单页应用，商品详情由 `mtop.taobao.idle.pc.detail` 接口返回（参数就一个 `itemId`）。
**接口带签名（sign / _m_h5_tk）**，用脚本在外部直接请求非常容易被风控，所以插件不用外部请求，而是**在页面内取数**，三层兜底：

**L1 拦截页面自己的请求（首选）**

`src/content/injected.js` 以 `world: "MAIN"` 注入，在 `document_start` 时机 hook 掉 `window.fetch` 与 `XMLHttpRequest`：

```js
// 页面自己调用详情接口时，顺手 clone 一份响应 JSON
if (API_RE.test(url)) copy.json().then(j => handleResponse(url, j));
```

好处：**零额外请求、天然带 cookie 与签名、不触发风控**。抓到后交给 `util.js` 的 `extractDetail()` 解析。

**L2 主动补一刀**

如果页面还没请求（例如用户直接点面板按钮），就用页面内的 `window.lib.mtop.request({ api: 'mtop.taobao.idle.pc.detail', v: '1.0', data: { itemId } })`
复用页面自带的签名环境发一次请求。

**L3 DOM 兜底**

接口全挂时，用启发式规则解析页面：标题取 `document.title`（去掉 `_闲鱼` 后缀）、店铺名取 `a[href*="personal?userId="]` 的文本、主图取 `img.alicdn.com` 的大尺寸图。

> 字段解析采用「**候选路径优先 + 全 JSON 深搜兜底**」（`util.js` 的 `U.deepFind`），
> 接口字段改名（如 `itemDO.title` → `title`）时通常不用改代码。

---

## 五、站点适配：加一个站点要改什么

所有「站点特有」的知识都集中在 `src/common/sites.js` 一张表里，主体引擎不感知站点。

一个站点需要配的东西：

| 配置项 | 作用 | 闲鱼 | 1688 |
| --- | --- | --- | --- |
| `hosts` | 域名识别 | goofish.com | 1688.com |
| `idRe` | 从链接里提取商品 ID | `?id=123` | `offer/123.html`、`offerId=123` |
| `itemUrl()` | 商品链接模板 | `/item?id=` | `/offer/123.html` |
| `cardSel` | 卡片容器选择器 | 空（靠尺寸推断） | `.sm-offer-item` 等 |
| `field.*` | 标题/价格/店铺/主图选择器 | 闲鱼风格 | 1688 风格 |
| `apiRe` | 接口拦截正则 | mtop 前缀 | 1688 域名 |
| `detailApi` | 详情补录接口 | mtop pc.detail | laputa JSONP |
| `shopPage` | 店铺页识别 | 无 | `shop*.1688.com` |

加新站点 = 在这张表里加一项（约 40 行），然后：

1. `manifest.json` 的 `host_permissions` 与两处 `content_scripts.matches` 加上域名
2. `sites.js` 里给该配置设 `enabled: true`
3. `ORDER` 数组里加上它的 key

**选择器不准怎么办：** 面板底部有「导出站点诊断」，点了会在 `诊断报告/` 里生成一个
报告文件，里面有：页面上的商品链接样本（含祖先元素的 class 链）、一批常见类名的命中数量、
当前抓到的卡片样本。把它发出来，据此填 `cardSel` / `field.*` 才是最准的，凭猜必然返工。

---

## 六、改版适配指南

| 现象 | 处理 |
| --- | --- |
| 面板显示「数据来源：页面解析」，字段不全 | 说明接口没被拦截到。打开 F12 → Network 过滤该站接口前缀，确认接口名，改对应站点的 `apiRe` |
| 某个字段每次都取不到 | 在 `util.js` 的 `extractDetail()` 里，把新字段路径加到对应 `grab([...])` 的第一位 |
| 主图下载后是压缩小图 | 检查 `normalizeImageUrl()` 的清洗规则；或改用拦截到的 `imageInfos` 原图地址 |
| 面板不出现 | 看扩展页是否有报错；确认页面域名匹配 `manifest.json` 里的 `matches` |

**列表页商品池（v1.1 起）**

列表页的数据不靠单次接口返回，而是走一个**累积式商品池**，这是滚动加载能持续出数的关键：

```
接口分页 / 滚动新增 DOM / 定时轮询  ──►  mergeCards()  ──►  cardMap[itemId]  ──►  面板
                                            ▲
                                     按 itemId 去重合并，
                                     只补空缺字段，绝不整体覆盖
```

- `injected.js` 里 `mergeCards()` 负责合并；旧的写法是 `state.cards = cards`（整体覆盖），
  每翻一页就把上一页丢掉，所以滚再多页面板数字也不动。
- 触发扫描：滚动 / 滚轮 / resize / MutationObserver / 每 4 秒兜底轮询，走 `requestIdleCallback` 避让主线程。
- 复选框由 `bridge.js` 插入，定位复用 `U.cardBox()`（与数据扫描同一套定位逻辑），
  React 重绘清掉复选框后 3 秒内会被自动补回。

调试技巧：在闲鱼页面按 F12，控制台执行：

```js
__XY__.getDetail()          // 当前抓到的商品数据
__XY__.getCards()           // 累积的商品池（滚动后会一直增长）
__XY__.scan()               // 立刻重扫一次页面 DOM
__XY__.refresh()            // 强制重新获取
```

> 若商品池数量增长得不合预期，先执行 `__XY__.scan()` 看 DOM 侧能扫出几条，
> 能扫出说明是接口合并的问题，扫不出说明页面结构变了，改 `util.js` 的 `U.scanCards()`。

---

## 七、注意事项

- 下载的图片版权归原作者，**仅供个人选品/存档参考**，请勿直接用于二次上架等侵权场景。
- 插件只在浏览器内读取你**已经能看到的页面数据**，不做批量爬取、不绕过登录，因此风控风险极低。
- 图片下载走浏览器原生下载器，若某张图下载失败，通常是该图 CDN 临时不可达，可在面板点「重新获取」再下。
- 价格字段单位按「元」处理，不做任何换算（防止 100 倍误差）。如遇某接口返回分，请在 `util.js` 的 `formatPrice()` 中显式处理。
