@echo off
rem boss-mcp 启动器（由 run-mcp.vbs 以隐藏窗口调用）。
rem
rem 为什么不做成 Windows 服务：服务跑在 Session 0，没有桌面也没有 GPU，
rem 而本项目要求有头浏览器 + 真实图形栈，服务化会直接踩到风控。
rem 为什么把输出重定向到 stdout.log：进程级崩溃、或被控制台「快速编辑模式」挂起时，
rem 结构化日志可能一个字都来不及写，只有这份重定向能兜住最后的输出；
rem 这类故障期间 node 进程和 3101 端口往往都还在，netstat / tasklist 一个都抓不到。
rem
rem 本文件必须是 GBK 编码 + CRLF 行尾（由仓库根 .gitattributes 保证行尾）。
rem   只有 LF 时，在多字节代码页下（zh-CN 默认 GBK，chcp 65001 亦然），中文注释的末字节
rem   会把紧随其后的换行一起吃掉，下一行被并进注释。实测后果：set LOGDIR 整行消失、
rem   %LOGDIR% 变成空、注释片段被当成命令执行、node 拿到乱码参数，脚本以退出码 1 结束，
rem   且 stdout.log 从未创建。而单字节代码页（chcp 437）下同一个文件完全正常——
rem   所以这种故障会随执行上下文时好时坏，极难定位。

setlocal

rem 由脚本自身位置推导仓库根目录（本文件在 <repo>\scripts\win-service\ 下），
rem 避免硬编码绝对路径——换机器或换用户名时那会静默失效。
for %%I in ("%~dp0..\..") do set REPO=%%~fI
set LOGDIR=%USERPROFILE%\.boss-cli\logs

if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Node 侧日志一律 UTF-8，而 Windows 的 type / Get-Content 默认按系统 ANSI(GBK) 解码，
rem 首次创建时补一个 UTF-8 BOM，让它们正确识别编码。
rem （mcp-server.log / mcp-access.log 由 mcp_log.ts 自己写 BOM，这里只管 stdout.log。）
if not exist "%LOGDIR%\stdout.log" (
  powershell -NoProfile -Command "[IO.File]::WriteAllText('%LOGDIR%\stdout.log', [char]0xFEFF, (New-Object Text.UTF8Encoding $false))"
)

rem 先留一行「启动器已到这里」，再做任何可能失败的事。
rem 现场教训：任务计划记录 LastTaskResult=1，但 crash 快照里连 stdout.log 都不存在，
rem 于是分不清「node 起来后退出」和「压根没走到 node」——此前第一行日志写在 cd 之后，
rem 而 stdout.log 只由 node 的输出重定向创建。这行改用 cmd 自己的重定向写，
rem 不依赖上面那句 powershell（它本身也可能是失败点）。
rem 落盘内容一律纯 ASCII：cmd 按控制台代码页解释本文件，中文 echo 会以乱码进日志。
echo [%DATE% %TIME%] launcher started, repo=%REPO% >> "%LOGDIR%\stdout.log"

cd /d "%REPO%" || (
  echo [%DATE% %TIME%] FATAL cd failed, repo=%REPO% >> "%LOGDIR%\stdout.log"
  exit /b 1
)

if not exist "dist\mcp\http_server.js" (
  echo [%DATE% %TIME%] FATAL dist\mcp\http_server.js not found, run npm run build first >> "%LOGDIR%\stdout.log"
  exit /b 1
)

echo [%DATE% %TIME%] starting boss-mcp >> "%LOGDIR%\stdout.log"
node dist\mcp\http_server.js >> "%LOGDIR%\stdout.log" 2>&1
set CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] boss-mcp exited with code %CODE% >> "%LOGDIR%\stdout.log"

rem 把 node 的退出码透传给任务计划，否则任务永远显示成功。
exit /b %CODE%

endlocal
