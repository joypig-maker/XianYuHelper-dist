@echo off
REM ===== 以调试模式启动 Chrome（保留原有登录态）=====
REM 用法：先完全关闭 Chrome（所有窗口），再双击本文件。
REM 启动后 调试端口 9222 生效，插件作者即可连上来实测页面结构。
REM 注意：本文件请勿移动到含中文的路径下，否则批处理可能解析失败。

set CHROME="C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist %CHROME% set CHROME="C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"

REM Chrome 强制要求：调试模式下必须显式指定 --user-data-dir，
REM 默认 profile 上开不了远程调试端口（会直接报
REM "DevTools remote debugging requires a non-default data directory"）。
REM 这个目录同时存着 1688 的登录态和已加载的解压扩展，别删。
set PROFILE=D:\work\xydebug-profile
if not exist "%PROFILE%" mkdir "%PROFILE%"

echo.
echo   [1/3] Closing any running Chrome instance...
taskkill /F /IM chrome.exe >nul 2>&1

echo   [2/3] Preparing debug profile: %PROFILE%
echo   [3/3] Starting Chrome with remote debugging on port 9222...
start "" %CHROME% --user-data-dir="%PROFILE%" --remote-debugging-port=9222 "https://www.1688.com/"

echo.
echo   Done. Keep this window open while you need the debugger.
echo   扩展源码目录 C:\Users\Public\XianYuHelper 改完代码后，
echo   在 chrome://extensions 点一次圆圈箭头即可生效。
echo   若扩展是从别的目录加载的，先删掉旧条目再「加载已解压的扩展程序」指向该目录。
pause
