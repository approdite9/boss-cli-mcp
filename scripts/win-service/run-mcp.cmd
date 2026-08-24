@echo off
rem boss-mcp 启动脚本（由 run-mcp.vbs 以隐藏窗口方式调用）
rem
rem 输出必须重定向到文件：只要进程还往控制台写，Windows 的「快速编辑模式」就能在
rem 有人点击窗口时把进程挂起（不是崩溃、不是退出，netstat 依旧显示 LISTENING）。
rem 重定向后进程完全不碰控制台，这条路径就被彻底堵死。

setlocal

set REPO=C:\Users\bowen\boss-cli
set LOGDIR=%USERPROFILE%\.boss-cli\logs

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

cd /d "%REPO%" || exit /b 1

echo [%DATE% %TIME%] starting boss-mcp >> "%LOGDIR%\stdout.log"
node dist\mcp\http_server.js >> "%LOGDIR%\stdout.log" 2>&1
echo [%DATE% %TIME%] boss-mcp exited with code %ERRORLEVEL% >> "%LOGDIR%\stdout.log"

endlocal
