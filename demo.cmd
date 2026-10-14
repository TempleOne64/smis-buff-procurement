@echo off
cd /d "%~dp0"
set FUNDING_DEMO=1
set PORT=8770
set OPEN_DASHBOARD=1
echo DEMO ONLY: Open http://127.0.0.1:8770 after startup.
where node >nul 2>nul
if errorlevel 1 (
  "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe" server.mjs
) else (
  node server.mjs
)
pause
