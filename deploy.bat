@echo off
chcp 65001 >nul 2>&1
cd /d "%~dp0"
REM 用法：deploy.bat <仓库名> [GitHubToken]
REM   deploy.bat XianYuHelper-dist ghp_xxxxxxxxxxxx
REM 不带参数时会提示；token 也可通过环境变量 GITHUB_TOKEN 传入
set REPO=%1
set TOKEN=%2
if "%REPO%"=="" set /p REPO=请输入要创建的 GitHub 仓库名: 
python tools/deploy_github.py --repo "%REPO%" --token "%TOKEN%"
pause
