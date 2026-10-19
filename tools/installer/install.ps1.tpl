#Requires -Version 3.0
param([switch]$Silent, [switch]$Elevated)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ExtensionId = '__EXT_ID__'
$CrxName     = '__CRX_NAME__'
$Version     = '__VERSION__'
# 自托管更新源基址（由 build_release.py 注入）。必须是 https:// 且可直接访问。
# 若仍是占位符（未配置真实托管地址），安装器会自动退化为「解压版 + 开发者模式手动加载」。
$UpdateBaseUrl = '__UPDATE_BASE_URL__'

$Browsers = @(
    @{
        Name    = 'Google Chrome'
        Exes    = @("$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
                    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")
        PolicyHKCU = 'HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
        PolicyHKLM = 'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist'
        ExtPage = 'chrome://extensions'
    },
    @{
        Name    = 'Microsoft Edge'
        Exes    = @("${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
                    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe")
        PolicyHKCU = 'HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'
        PolicyHKLM = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'
        ExtPage = 'edge://extensions'
    }
)

function Say([string]$msg, [string]$color = 'Gray') {
    Write-Host $msg -ForegroundColor $color
}

function Line([string]$color = 'Cyan') {
    Say '============================================================' $color
}

function Is-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
        [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Banner {
    Clear-Host
    Line
    Say '   __PRODUCT__' 'Yellow'
    Say '   一键安装  v__VERSION__' 'White'
    Line
    Say ''
}

function Pick-InstallDir {
    foreach ($dir in @((Join-Path $env:PUBLIC 'XianYuHelper'), (Join-Path $env:LOCALAPPDATA 'XianYuHelper'))) {
        try {
            if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
            $probe = Join-Path $dir '.writetest'
            [IO.File]::WriteAllText($probe, 'ok')
            Remove-Item $probe -Force
            return $dir
        } catch { }
    }
    throw '无法创建安装目录（%PUBLIC% 与 %LOCALAPPDATA% 均不可写），请右键以管理员身份重试。'
}

function Repair-Layout([string]$src) {
    # 自愈：老版本安装包把扩展放在 extension/ 子目录里，
    # 会让「根目录」缺少 manifest.json。客户手动加载时必然报
    # 「清单文件缺失或不可读取」，而且完全看不出是选错了目录。
    # 这里统一提升到根目录，保证 $src 永远是可加载的扩展目录。
    if (Test-Path (Join-Path $src 'manifest.json')) { return $src }
    $nested = Join-Path $src 'extension'
    if (-not (Test-Path (Join-Path $nested 'manifest.json'))) { return $src }
    Say '  检测到扩展位于 extension/ 子目录，自动提升到根目录 ...' 'Yellow'
    Get-ChildItem -Path $nested -Recurse -File | ForEach-Object {
        $rel = $_.FullName.Substring($nested.Length).TrimStart('\', '/')
        $dst = Join-Path $src $rel
        New-Item -ItemType File -Path $dst -Force | Out-Null
        Copy-Item $_.FullName $dst -Force
    }
    return $src
}

function Deploy-Files([string]$src, [string]$installDir) {
    if (-not (Test-Path (Join-Path $src 'manifest.json'))) {
        throw '安装包缺少 manifest.json，请重新下载安装包'
    }
    # 整目录复制：$installDir 本身就是一个完整可加载的扩展目录，
    # 手动加载时直接选中它，不用再去找 extension/ 子目录。
    foreach ($old in @((Join-Path $installDir 'extension'), (Join-Path $installDir 'hosting'))) {
        if (Test-Path $old) { Remove-Item $old -Recurse -Force -ErrorAction SilentlyContinue }
    }
    foreach ($item in (Get-ChildItem -Path $src -Force)) {
        $dst = Join-Path $installDir $item.Name
        if ($item.PSIsContainer) {
            New-Item -ItemType Directory -Path $dst -Force | Out-Null
            Copy-Item $item.FullName $dst -Recurse -Force
        } else {
            Copy-Item $item.FullName $dst -Force
        }
    }
    $crx = Join-Path $installDir $CrxName
    if (-not (Test-Path $crx)) {
        Say '  提示: 当前安装包未附带 crx（仅解压版），策略安装仍可用。' 'Yellow'
        return 0
    }
    if ((Get-Item $crx).Length -lt 1024) { throw 'crx 文件损坏，请重新下载安装包' }
    return [math]::Round((Get-Item $crx).Length / 1KB, 1)
}

function Install-Policy([string]$regKey, [string]$manifestUrl) {
    $value = $ExtensionId + ';' + $manifestUrl
    try {
        if (-not (Test-Path $regKey)) { New-Item -Path $regKey -Force -ErrorAction Stop | Out-Null }
        $existing = Get-ItemProperty -Path $regKey -ErrorAction SilentlyContinue
        $slot = $null
        if ($existing) {
            foreach ($p in $existing.PSObject.Properties) {
                if ($p.Name -match '^\d+$' -and $p.Value -like ($ExtensionId + ';*')) { $slot = $p.Name; break }
            }
        }
        if (-not $slot) {
            $i = 1
            while ($existing -and ($existing.PSObject.Properties | Where-Object { $_.Name -eq ([string]$i) })) { $i++ }
            $slot = [string]$i
        }
        New-ItemProperty -Path $regKey -Name $slot -Value $value -PropertyType String -Force -ErrorAction Stop | Out-Null
        return @{ Ok = $true; Url = $value }
    } catch {
        return @{ Ok = $false; Url = $value; Err = $_.Exception.Message }
    }
}

function Start-Fallback([hashtable]$br, [string]$extDir) {
    Say ('  [!!] ' + $br.Name + ' 自动安装被系统策略拦截，改用半自动方式') 'Yellow'
    $exe = $br.Exes | Where-Object { Test-Path $_ } | Select-Object -First 1
    try { Set-Clipboard -Value $extDir } catch { }
    if (-not $Silent -and $exe) {
        try { Start-Process $exe $br.ExtPage } catch { }
    }
    return $true
}

# ------------------------------------------------------------------ 主流程

Banner
$src = Repair-Layout (Split-Path -Parent $MyInvocation.MyCommand.Path)

Say '[1/4] 准备安装目录 ...' 'Yellow'
$installDir = Pick-InstallDir
Say ('       ' + $installDir) 'White'

Say '[2/4] 释放插件文件 ...' 'Yellow'
$kb = Deploy-Files $src $installDir
Say ('       版本 ' + $Version + '  (' + $kb + ' KB)') 'Green'

Say '[3/4] 注册浏览器安装策略 ...' 'Yellow'
$detected = @()
foreach ($br in $Browsers) {
    $found = ($br.Exes | Where-Object { Test-Path $_ } | Select-Object -First 1)
    if (-not $found) { Say ('  [--] ' + $br.Name + ' 未安装，跳过') 'DarkGray'; continue }
    $detected += ,@($br, $found)
}

if ($detected.Count -eq 0) {
    Say '' 'White'
    throw "未检测到 Chrome 或 Edge，请先安装其中一个浏览器。`n  Chrome 下载: https://www.google.cn/chrome/"
}

# 是否配置了真实 HTTPS 托管地址（Chrome 137+ 不再接受 file:// 作为扩展更新源）
$usePolicy = $UpdateBaseUrl -match '^https://'
if ($usePolicy) {
    $manifestUrl = $UpdateBaseUrl.TrimEnd('/') + '/update.xml'
    Say ('  托管地址: ' + $manifestUrl) 'White'
} else {
    Say '  [!!] 未配置 HTTPS 托管地址（当前为占位符）' 'Yellow'
    Say '      将使用「解压版 + 开发者模式手动加载」兜底（无需托管，但需用户手动点几下）。' 'Yellow'
    Say '      如要自动安装，请把 build_release.py 的 UPDATE_BASE_URL 改成真实 HTTPS 地址后重新生成。' 'DarkGray'
}

$results = @{}
foreach ($pair in $detected) {
    $br = $pair[0]
    if (-not $usePolicy) { $results[$br.Name] = @{ Ok = $false; Url = '' }; continue }
    $key = if (Is-Admin) { $br.PolicyHKLM } else { $br.PolicyHKCU }
    $r = Install-Policy $key $manifestUrl
    if (-not $r.Ok -and -not (Is-Admin)) {
        # 权限不足时尝试 HKLM 作为补充（普通用户会失败，管理员环境会成功）
        $r2 = Install-Policy $br.PolicyHKLM $manifestUrl
        if ($r2.Ok) { $r = $r2 }
    }
    $results[$br.Name] = $r
    if ($r.Ok) {
        Say ('  [OK] ' + $br.Name + ' 策略已写入') 'Green'
        Say ('       ' + $r.Url) 'DarkGray'
    } else {
        Say ('  [NG] ' + $br.Name + ' 策略写入失败: ' + $r.Err) 'Red'
    }
}

$failed = @($detected | Where-Object { -not $results[$_[0].Name].Ok })

# 未提权则再申请一次管理员权限（静默模式下跳过 UAC，静默部署应已具备管理员权限）
if ($usePolicy -and $failed.Count -gt 0 -and -not $Elevated -and -not (Is-Admin) -and -not $Silent) {
    Say '' 'White'
    Say '  系统策略受限制，尝试请求管理员权限重试 ...' 'Yellow'
    try {
        Start-Process powershell -Verb RunAs -Wait -ArgumentList `
            '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Elevated', '-Silent'
    } catch { }
    foreach ($pair in $detected) {
        $br = $pair[0]
        if ($results[$br.Name].Ok) { continue }
        $r = Install-Policy $br.PolicyHKLM $manifestUrl
        if ($r.Ok) {
            $results[$br.Name] = $r
            Say ('  [OK] ' + $br.Name + ' 已通过管理员权限写入策略') 'Green'
            Say ('       ' + $r.Url) 'DarkGray'
        }
    }
    $failed = @($detected | Where-Object { -not $results[$_[0].Name].Ok })
}

Say '' 'White'
Say '[4/4] 完成安装' 'Yellow'
Say '' 'White'

$autoCount = $detected.Count - $failed.Count
# 手动加载时要选的目录：就是安装目录本身（根目录含 manifest.json）
$extDir = $installDir
$fallbackUsed = $false
if ($failed.Count -gt 0) {
    $fallbackUsed = $true
    foreach ($pair in $detected) {
        if (-not $results[$pair[0].Name].Ok) { Start-Fallback $pair[0] $extDir | Out-Null }
    }
}

if ($autoCount -gt 0) {
    Say ('  ' + $autoCount + ' 个浏览器已自动配置，请【完全退出浏览器】（含右下角托盘图标）后重新打开，') 'White'
    Say '  插件会自动加载并出现在工具栏。' 'White'
}
if ($fallbackUsed) {
    Say '' 'White'
    Say '  另有浏览器因系统限制无法自动安装，已为你打开扩展页面：' 'Yellow'
    Say '' 'White'
    Say ('    1) 打开右上角「开发者模式」开关') 'White'
    Say ('    2) 点「加载已解压的扩展程序」') 'White'
    Say ('    3) 目录已复制到剪贴板，粘贴后回车即可: ' + $extDir) 'White'
    Say ('       （也可手动复制上面的路径）') 'DarkGray'
}
Say '' 'White'
Say '  使用方式：打开闲鱼商品页 https://www.goofish.com' 'White'
Say '            右下角出现采集面板，即可复制链接 / 标题 / 店铺名 / 主图 / 文案。' 'White'
Say '' 'White'
Line

if ($Silent) { exit 0 }

try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    $msg = if ($failed.Count -eq 0) {
        '安装成功！' + [Environment]::NewLine + [Environment]::NewLine +
        '请完全退出浏览器（含右下角托盘图标）后重新打开，' + [Environment]::NewLine +
        '插件会自动加载并固定在工具栏。'
    } else {
        '已为你打开浏览器扩展页面。' + [Environment]::NewLine + [Environment]::NewLine +
        '请依次：打开右上角「开发者模式」→ 点「加载已解压的扩展程序」→ ' + [Environment]::NewLine +
        '粘贴路径并确定（路径已复制到剪贴板）。' + [Environment]::NewLine + [Environment]::NewLine + $extDir
    }
    [System.Windows.Forms.MessageBox]::Show($msg, '闲鱼助手 - 安装完成', 'OK', 'Information') | Out-Null
} catch { }
