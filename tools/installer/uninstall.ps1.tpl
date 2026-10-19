#Requires -Version 3.0
param([switch]$Silent)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

$ExtensionId = '__EXT_ID__'

$PolicyKeys = @(
    'HKCU:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist',
    'HKLM:\SOFTWARE\Policies\Google\Chrome\ExtensionInstallForcelist',
    'HKCU:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist',
    'HKLM:\SOFTWARE\Policies\Microsoft\Edge\ExtensionInstallForcelist'
)

function Say([string]$msg, [string]$color = 'Gray') { Write-Host $msg -ForegroundColor $color }
function Line([string]$color = 'Cyan') { Say '============================================================' $color }

Clear-Host
Line
Say '   __PRODUCT__' 'Yellow'
Say '   卸载' 'White'
Line
Say ''

Say '[1/2] 移除浏览器安装策略 ...' 'Yellow'
$removed = 0
foreach ($k in $PolicyKeys) {
    if (-not (Test-Path $k)) { continue }
    try {
        $props = Get-ItemProperty -Path $k
        foreach ($p in $props.PSObject.Properties) {
            if ($p.Name -match '^\d+$' -and $p.Value -like ($ExtensionId + ';*')) {
                Remove-ItemProperty -Path $k -Name $p.Name -Force -ErrorAction Stop
                Say ('  [OK] 已移除 ' + $k + ' 槽位 ' + $p.Name) 'Green'
                $removed++
            }
        }
        $left = @(Get-ItemProperty -Path $k | Get-Member -MemberType NoteProperty |
                  Where-Object { $_.Name -match '^\d+$' }).Count
        if ($left -eq 0) { Remove-Item -Path $k -Force -ErrorAction SilentlyContinue }
    } catch {
        Say ('  [!!] ' + $k + ' 无法清理（可能无权限）: ' + $_.Exception.Message) 'Red'
    }
}
if ($removed -eq 0) { Say '  [--] 未发现自动安装记录（可能从未安装、或已清理）' 'Yellow' }

Say '[2/2] 清理本地文件 ...' 'Yellow'
foreach ($root in @($env:PUBLIC, $env:LOCALAPPDATA)) {
    $dir = Join-Path $root 'XianYuHelper'
    if (Test-Path $dir) {
        try {
            Remove-Item $dir -Recurse -Force -ErrorAction Stop
            Say ('  [OK] 已删除 ' + $dir) 'Green'
        } catch {
            Say ('  [!!] 无法删除 ' + $dir + '（可能被浏览器占用，请先完全退出浏览器后重试）') 'Red'
        }
    }
}

Say '' 'White'
Say '  卸载完成。' 'White'
if ($removed -gt 0) {
    Say '  请重启浏览器，插件会被自动移除。' 'White'
} else {
    Say '  若使用的是开发者模式手动加载，请在浏览器扩展页手动移除本插件。' 'White'
}
Say '' 'White'
Line

if ($Silent) { exit 0 }

try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    [System.Windows.Forms.MessageBox]::Show('卸载完成，请重启浏览器。', '闲鱼助手 - 已卸载', 'OK', 'Information') | Out-Null
} catch { }
