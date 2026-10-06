@echo off
chcp 65001 >nul
title Bluebird 打包
cd /d "%~dp0"
rem 这个脚本可以放在任何地方：找不到项目时自动进入「文档\Bluebird」
if not exist "package.json" cd /d "%USERPROFILE%\Documents\Bluebird"
if not exist "package.json" goto noproject

rem 打包工具和 Electron 从国内镜像下载
set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
rem 不做代码签名（自己用不需要）
set CSC_IDENTITY_AUTO_DISCOVERY=false

where node >nul 2>nul
if errorlevel 1 goto nonode

rem 依赖已经装好、并且 package.json 自上次安装后没变过，就不用重装
fc /b package.json "node_modules\.bluebird-installed.json" >nul 2>nul
if not errorlevel 1 if exist "node_modules\electron\dist\electron.exe" goto build
echo.
echo  正在安装依赖，需要几分钟...
call npm install --registry=https://registry.npmmirror.com --no-fund --no-audit > setup.log 2>&1
if errorlevel 1 if exist "node_modules\electron\dist\electron.exe" goto build
if errorlevel 1 goto installfail
if not exist "node_modules\electron\dist\electron.exe" goto installfail
copy /y package.json "node_modules\.bluebird-installed.json" >nul

:build
echo.
echo  正在打包安装程序，第一次需要下载打包工具，大约 3 到 10 分钟。
echo  打包前请先关闭正在运行的 Bluebird。请不要关闭这个窗口...
echo.
rem 先清掉上一次打包的结果，免得这次失败了还把旧的安装程序当成新的
if exist "dist" rmdir /s /q "dist"
if exist "dist" goto distlocked
call npm run dist:win > build.log 2>&1
if errorlevel 1 goto buildfail
if not exist "dist\Bluebird-Setup-*.exe" goto buildfail

echo  打包完成。安装程序是 dist 文件夹里的「Bluebird-Setup-版本号.exe」，马上为你打开。
echo  安装前请先关闭正在运行的 Bluebird（包括那个黑色窗口）。
start "" explorer "%cd%\dist"
pause
exit /b 0

:noproject
echo  没有找到 Bluebird 项目文件夹（文档\Bluebird）。
pause
exit /b 1

:nonode
echo  没有找到 Node.js，请先到 https://nodejs.org 安装 22 LTS 版本。
pause
exit /b 1

:installfail
echo.
echo  依赖安装失败。详细信息保存在 setup.log 里，把情况告诉 Claude 即可。
pause
exit /b 1

:distlocked
echo.
echo  上一次打包留下的 dist 文件夹删不掉，多半是里面的 Bluebird 还开着。
echo  请关闭所有 Bluebird 窗口后，重新双击本文件。
pause
exit /b 1

:buildfail
echo.
echo  打包失败。下面是日志的最后几行，完整内容在 build.log 里，把情况告诉 Claude 即可。
echo  ----------------------------------------------------------------
powershell -NoProfile -Command "Get-Content -Encoding UTF8 build.log -Tail 20"
echo  ----------------------------------------------------------------
pause
exit /b 1
