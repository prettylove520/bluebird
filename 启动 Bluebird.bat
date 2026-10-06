@echo off
chcp 65001 >nul
title Bluebird
cd /d "%~dp0"
rem 这个脚本可以放在任何地方（比如桌面）：找不到项目时自动进入「文档\Bluebird」
if not exist "package.json" cd /d "%USERPROFILE%\Documents\Bluebird"
if not exist "package.json" goto noproject

rem 让 Electron 和依赖包从国内镜像下载
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/

where node >nul 2>nul
if errorlevel 1 goto nonode

echo Node 版本: > setup.log
node -v >> setup.log 2>&1
call npm -v >> setup.log 2>&1

rem 依赖已经装好、并且 package.json 自上次安装后没变过，就不用重装
fc /b package.json "node_modules\.bluebird-installed.json" >nul 2>nul
if not errorlevel 1 if exist "node_modules\electron\dist\electron.exe" goto run

echo.
echo  正在安装依赖，第一次需要几分钟，请不要关闭这个窗口...
echo.
call npm install --registry=https://registry.npmmirror.com --no-fund --no-audit >> setup.log 2>&1
if errorlevel 1 if exist "node_modules\electron\dist\electron.exe" goto run
if errorlevel 1 goto installfail
if not exist "node_modules\electron\dist\electron.exe" goto installfail
copy /y package.json "node_modules\.bluebird-installed.json" >nul
echo  依赖安装完成。

:run
echo.
echo  正在启动 Bluebird，窗口稍后会出现。关闭这个黑色窗口会同时退出程序。
echo.
call npm run dev > run.log 2>&1
if errorlevel 1 goto runfail
exit /b 0

:nonode
echo  没有找到 Node.js，请先到 https://nodejs.org 安装 22 LTS 版本，然后重新双击本文件。
pause
exit /b 1

:noproject
echo  没有找到 Bluebird 项目文件夹（文档\Bluebird）。
pause
exit /b 1

:installfail
echo.
echo  依赖安装失败。详细信息已经保存在 setup.log 里，把情况告诉 Claude 即可。
pause
exit /b 1

:runfail
echo.
echo  启动失败。详细信息已经保存在 run.log 里，把情况告诉 Claude 即可。
pause
exit /b 1
