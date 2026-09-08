@echo off
setlocal
rem Work-hours liveness patrol for the recommend page.
rem
rem ASCII only and CRLF on purpose: a .cmd with non-ASCII comments and LF
rem endings breaks silently under codepage 936 - the comment bytes swallow the
rem newline and the scheduled task exits 1 with no log. See .gitattributes.
rem
rem Scheduled every 10 minutes between 08:00 and 18:00. The script itself skips
rem when a real tool call ran in the last 90 seconds, so a patrol can never
rem collide with work in progress.

set REPO=%USERPROFILE%\boss-cli
set LOGDIR=%USERPROFILE%\.boss-cli\logs
if not exist "%LOGDIR%" mkdir "%LOGDIR%"

cd /d "%REPO%" || exit /b 1

node scripts\win-service\recommend-liveness.mjs >> "%LOGDIR%\recommend-liveness.log" 2>&1
set CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] recommend-liveness exit=%CODE% >> "%LOGDIR%\recommend-liveness.log"
exit /b %CODE%
