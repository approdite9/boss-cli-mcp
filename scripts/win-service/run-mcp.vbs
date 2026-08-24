' boss-mcp 隐藏窗口启动器
'
' 第三个参数 0 = 隐藏窗口。没有可见控制台，就没人能点进去把进程选中挂起。
' 第二个参数 False = 不等待子进程结束，立即返回（任务计划不会一直挂着）。
'
' 由任务计划以「只在用户登录时运行」触发，从而跑在真实的交互桌面会话里——
' 有头 Chrome 必需。切勿改成 Windows 服务：服务在 Session 0，没有桌面也没有 GPU。

Dim shell
Set shell = CreateObject("WScript.Shell")
shell.Run "cmd /c """ & "C:\Users\bowen\boss-cli\scripts\win-service\run-mcp.cmd" & """", 0, False
