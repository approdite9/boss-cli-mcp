<#
boss-mcp 看门狗：探活 → 失败时留证 → 重启。

为什么不能只查进程和端口
------------------------
本服务的两类历史故障期间，node 进程都还在、3101 端口都还 LISTENING：
  1. 控制台「快速编辑模式」在有人点击窗口时挂起进程（不是崩溃、不是退出）
  2. 早期实现在请求路径上 await transport.close()，被死掉的对端拖住数分钟
所以 tasklist / netstat 这类检查一个都抓不到。判据必须是**一次真实 HTTP 请求**。

为什么探 /health 而不是 /mcp
----------------------------
POST /mcp 的 initialize 会在会话表里建记录。每分钟探一次会不断挤占会话上限（64），
把真实客户端的会话按 LRU 淘汰掉。/health 零协议副作用，也不碰浏览器、不消耗配额。

为什么用 PowerShell 而不是 Node
-------------------------------
重启时要杀 node 进程。若看门狗自身也是 Node，容易把自己一起杀掉。

用法（通常由任务计划每 2 分钟调用一次）：
  powershell -ExecutionPolicy Bypass -NoProfile -File watchdog-mcp.ps1
#>

[CmdletBinding()]
param(
    [int]    $Port            = 3101,
    [int]    $TimeoutSec      = 10,
    # 连续失败几次才动手。设 >1 是为了避开偶发抖动，别因为一次网络毛刺就重启一个
    # 可能正在跑长任务的服务。
    [int]    $FailuresBeforeRestart = 2,
    [string] $Launcher        = 'C:\Users\bowen\boss-cli\scripts\win-service\run-mcp.vbs',
    [string] $LogDir          = "$env:USERPROFILE\.boss-cli\logs"
)

$ErrorActionPreference = 'Stop'

$WatchdogLog = Join-Path $LogDir 'watchdog.log'
$StateFile   = Join-Path $LogDir 'watchdog-failures.txt'
$CrashRoot   = Join-Path $LogDir 'crash'

# 首次运行时日志目录可能还不存在（服务尚未启动过）。必须在任何写入之前建好，
# 包括「健康」这条不写日志、只更新失败计数的路径。
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }

function Write-WatchdogLog([string]$Level, [string]$Message) {
    $line = '{0} [{1}] {2}' -f (Get-Date -Format 'yyyy-MM-ddTHH:mm:ss.fffZ'), $Level, $Message
    Add-Content -Path $WatchdogLog -Value $line -Encoding UTF8
}

function Get-ListeningPid([int]$P) {
    try {
        $c = Get-NetTCPConnection -LocalPort $P -State Listen -ErrorAction Stop | Select-Object -First 1
        return $c.OwningProcess
    } catch {
        return $null
    }
}

function Test-Health([int]$P, [int]$Sec) {
    try {
        $r = Invoke-WebRequest -Uri "http://127.0.0.1:$P/health" -TimeoutSec $Sec -UseBasicParsing
        if ($r.StatusCode -ne 200) { return @{ ok = $false; reason = "status=$($r.StatusCode)" } }
        return @{ ok = $true; body = $r.Content }
    } catch {
        return @{ ok = $false; reason = $_.Exception.Message }
    }
}

# 失败前留证：日志快照 + 现场状态。重启会毁掉现场，所以必须先抓。
function Save-CrashSnapshot([string]$Reason, $ServicePid) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dir   = Join-Path $CrashRoot $stamp
    New-Item -ItemType Directory -Path $dir -Force | Out-Null

    Set-Content -Path (Join-Path $dir 'reason.txt') -Encoding UTF8 -Value @(
        "time   : $(Get-Date -Format o)"
        "reason : $Reason"
        "pid    : $(if ($ServicePid) { $ServicePid } else { '<not listening>' })"
    )

    foreach ($name in 'mcp-server.log', 'mcp-access.log', 'stdout.log', 'watchdog.log') {
        $src = Join-Path $LogDir $name
        if (Test-Path $src) {
            # 复制而非移动：服务日志要保持连续，别让排查手段本身制造断点
            Copy-Item $src (Join-Path $dir $name) -ErrorAction SilentlyContinue
        }
    }

    # 现场状态：区分「进程没了」「端口没了」「都在但不响应（冻结/阻塞）」
    & netstat -ano | Select-String ":$Port" |
        Out-File (Join-Path $dir 'netstat.txt') -Encoding UTF8
    Get-Process node -ErrorAction SilentlyContinue |
        Select-Object Id, StartTime, WorkingSet64, Responding |
        Format-List | Out-File (Join-Path $dir 'node-processes.txt') -Encoding UTF8
    Get-Process chrome -ErrorAction SilentlyContinue |
        Select-Object Id, StartTime, WorkingSet64 |
        Format-List | Out-File (Join-Path $dir 'chrome-processes.txt') -Encoding UTF8

    Write-WatchdogLog 'INFO' "现场已保存：$dir"
    return $dir
}

function Restart-Service([string]$Reason) {
    $servicePid = Get-ListeningPid $Port
    $snapshot = Save-CrashSnapshot -Reason $Reason -ServicePid $servicePid

    if ($servicePid) {
        Write-WatchdogLog 'WARN' "结束占用 $Port 的进程 PID=$servicePid"
        # 按 PID 杀，不用 /im node.exe：那会连带干掉机器上其它 Node 进程
        try { Stop-Process -Id $servicePid -Force -ErrorAction Stop } catch {
            Write-WatchdogLog 'ERROR' "结束进程失败：$($_.Exception.Message)"
        }
        # 等端口释放，避免新实例绑到还没回收的端口上
        for ($i = 0; $i -lt 20; $i++) {
            if (-not (Get-ListeningPid $Port)) { break }
            Start-Sleep -Milliseconds 500
        }
    } else {
        Write-WatchdogLog 'WARN' "端口 $Port 上没有监听进程，直接启动"
    }

    # 刻意不动 Chrome：它是 detached 启动的，能跨 node 重启存活，
    # 登录态就在它的 profile 里。杀掉它会逼用户重新扫码。
    Write-WatchdogLog 'INFO' "启动 $Launcher"
    & wscript.exe $Launcher

    Start-Sleep -Seconds 8
    $h = Test-Health $Port $TimeoutSec
    if ($h.ok) {
        Write-WatchdogLog 'INFO' "重启成功：$($h.body)"
    } else {
        Write-WatchdogLog 'ERROR' "重启后仍不健康：$($h.reason)（现场见 $snapshot）"
    }
}

# ── 主流程 ────────────────────────────────────────────────────

$failures = 0
if (Test-Path $StateFile) {
    $raw = (Get-Content $StateFile -Raw).Trim()
    if ($raw -match '^\d+$') { $failures = [int]$raw }
}

$health = Test-Health $Port $TimeoutSec

if ($health.ok) {
    if ($failures -gt 0) {
        Write-WatchdogLog 'INFO' "恢复健康，清零失败计数（此前 $failures 次）"
    }
    Set-Content -Path $StateFile -Value '0' -Encoding UTF8
    exit 0
}

$failures++
Set-Content -Path $StateFile -Value $failures -Encoding UTF8
Write-WatchdogLog 'WARN' "探活失败（第 $failures/$FailuresBeforeRestart 次）：$($health.reason)"

if ($failures -ge $FailuresBeforeRestart) {
    Restart-Service -Reason $health.reason
    Set-Content -Path $StateFile -Value '0' -Encoding UTF8
}
