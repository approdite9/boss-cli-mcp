' boss-mcp 隐藏窗口启动器
'
' 由任务计划以「只在用户登录时运行」触发，从而跑在真实的交互桌面会话里——有头 Chrome 必需。
' 切勿改成 Windows 服务：服务在 Session 0，没有桌面也没有 GPU。
'
' shell.Run 的两个参数含义：
'   0    = 隐藏窗口。没有可见控制台，就没人能点进去把进程选中挂起
'          （Windows「快速编辑模式」会在有人点击窗口时挂起进程，表现为服务假死）。
'   True = **等待子进程结束**。这一条是必须的：
'          若用 False（发射后不管），wscript 会立刻退出，任务计划便认为任务已完成，
'          于是 `schtasks /end` 无从终止真正的 node 进程，
'          而且任务永远"成功"，「失败时重启」永不触发。
'
' 最后把退出码透传给任务计划，让重启策略能真正生效。

Dim fso, shell, here, code

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' 由脚本自身位置推导同目录的 cmd，避免硬编码绝对路径（换机器/换用户名时静默失效）
here = fso.GetParentFolderName(WScript.ScriptFullName)

code = shell.Run("cmd /c """ & here & "\run-mcp.cmd""", 0, True)

WScript.Quit code
