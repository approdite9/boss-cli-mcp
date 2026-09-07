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

cd /d "%REPO%" || exit /b 1

node skills\boss-frontend-analysis\scripts\selector_watch.mjs --check >> "%LOGDIR%\cron.log" 2>&1
set CODE=%ERRORLEVEL%
echo [%DATE% %TIME%] selector_watch exit=%CODE% >> "%LOGDIR%\cron.log"
exit /b %CODE%
