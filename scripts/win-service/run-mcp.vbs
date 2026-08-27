' boss-mcp 本地启动包装器
'
' 任务计划以「只在用户登录时运行」触发它，从而继承真实的交互式会话（有头 Chrome 必需）。
' 不做成 Windows 服务：服务跑在 Session 0，没有桌面也没有 GPU。
'
' shell.Run 的两个参数含义：
'   0    = 隐藏窗口。没有可见控制台，就没人能点进去把进程选中挂起
'          （Windows「快速编辑模式」下点一下窗口就会冻住进程，表现为服务假死）。
'   True = **等待子进程结束**，这一点是必须的：
'          换成 False（发起后不管），wscript 会立刻退出，任务计划就认为任务已完成，
'          于是 `schtasks /end` 无从终止真正的 node 进程，
'          任务状态也永远显示「成功」，失败时不会有任何线索。
'
' 子进程退出码透传给任务计划，否则任务永远显示成功。
'
' 注意：本文件为 GBK 编码（wscript 按系统 ANSI 读取脚本）。
' 写日志的字符串一律用纯 ASCII，避免再引入一层编码不确定性。

Dim fso, shell, here, code, logPath, message

Set fso   = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

' 由脚本自身位置推导同目录的 cmd，避免硬编码绝对路径（换机器/换用户名时会静默失效）。
here = fso.GetParentFolderName(WScript.ScriptFullName)
logPath = shell.ExpandEnvironmentStrings("%USERPROFILE%") & "\.boss-cli\logs\launcher.log"

' 这一层此前完全不留痕：无论是 shell.Run 抛错，还是 cmd 以非零码退出，
' wscript 都只是安静地以非零码结束，任务计划只剩一个 LastTaskResult=1，
' 日志目录里什么都没有（现场就遇到过：LastTaskResult=1 且连 stdout.log 都不存在）。
' 这里两种情况都记一行，然后照原样以非零码退出 —— 只补证据，不改变失败语义。
On Error Resume Next

code = shell.Run("cmd /c """ & here & "\run-mcp.cmd""", 0, True)

If Err.Number <> 0 Then
  message = "FATAL cannot start run-mcp.cmd: err=" & Err.Number & " " & Err.Description & " here=" & here
  Err.Clear
  WriteLauncherLog logPath, message
  WScript.Quit 1
End If

On Error Goto 0

If code <> 0 Then
  WriteLauncherLog logPath, "run-mcp.cmd exited with code " & code & ", see stdout.log; here=" & here
End If

WScript.Quit code

' 日志写不进去不该改变退出码，所以这里吞掉写入自身的错误（但只吞它）。
Sub WriteLauncherLog(path, text)
  Dim stream
  On Error Resume Next
  Set stream = fso.OpenTextFile(path, 8, True)
  If Err.Number = 0 Then
    stream.WriteLine Now & " " & text
    stream.Close
  End If
  Err.Clear
  On Error Goto 0
End Sub
