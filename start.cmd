@echo off
cd /d "%~dp0"
set FUNDING_DEMO=0
set PORT=8769
set OPEN_DASHBOARD=1
echo Open http://127.0.0.1:8769 after startup.
where node >nul 2>nul
if errorlevel 1 (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs
) else (
  node server.mjs
)
pause
