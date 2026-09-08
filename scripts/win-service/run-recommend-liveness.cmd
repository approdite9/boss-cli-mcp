@echo off
setlocal
rem Work-hours liveness patrol for the recommend page.
rem
rem ASCII only and CRLF on purpose: a .cmd with non-ASCII comments and LF
rem endings breaks silently under codepage 936 - the comment bytes swallow the
rem newline and the scheduled task exits 1 with no log. See .gitattributes.
rem
rem Scheduled every 10 minutes between 08:00 and 18:00. Two reasons a patrol can
rem never interfere with work in progress:
rem   - the script skips entirely if a real tool call ran in the last 90 seconds
rem   - --recover is NOT passed, so it only probes and reports. Probing sends one
rem     Runtime.evaluate over a bare WebSocket: no navigation, no click, no
rem     reload, and the tab set is left exactly as it was. Recovery would swap
rem     tabs, which reloads the candidate list and may change the selected job -
rem     unacceptable when the workflow pins the job for the whole run.

set REPO=%USERPROFILE%\boss-cli
set LOGDIR=%USERPROFILE%\.boss-cli\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

cd /d "%REPO%" || exit /b 1

node scripts\win-service\recommend-liveness.mjs >> "%LOGDIR%\recommend-liveness.log" 2>&1
set CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] recommend-liveness exit=%CODE% >> "%LOGDIR%\recommend-liveness.log"
exit /b %CODE%
