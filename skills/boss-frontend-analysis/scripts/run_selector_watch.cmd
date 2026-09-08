@echo off
setlocal
rem Nightly entry point for the Boss selector watch.
rem
rem ASCII only on purpose: this repo already hit the failure where a .cmd with
rem non-ASCII comments and LF endings breaks silently under codepage 936 --
rem comment bytes swallow the newline, the next line joins the comment, and the
rem scheduled task exits 1 with no log at all. See .gitattributes for details.
rem
rem Detection only. --apply is deliberately NOT passed: an auto-rewritten
rem selector still needs a human to look at the diff before it ships.

set REPO=%USERPROFILE%\boss-cli
set LOGDIR=%USERPROFILE%\.boss-cli\logs\selector-watch
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

rem Bound Chrome's verbose log while renderer-wedge forensics is enabled.
rem Chrome truncates it only on browser restart, and the page's anti-debug code
rem hammers console.log, so it grows about 45KB per minute - roughly 450MB a week.
rem Rotate at 300MB, keep one generation. Harmless when the log does not exist.
powershell -NoProfile -Command "$f='%USERPROFILE%\.boss-cli\logs\chrome_debug.log'; if ((Test-Path $f) -and ((Get-Item $f).Length -gt 300MB)) { Move-Item $f ($f + '.old') -Force }"

cd /d "%REPO%" || exit /b 1

node skills\boss-frontend-analysis\scripts\selector_watch.mjs --check >> "%LOGDIR%\cron.log" 2>&1
set CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] selector_watch exit=%CODE% >> "%LOGDIR%\cron.log"
exit /b %CODE%
