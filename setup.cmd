@echo off
cd /d "%~dp0"
where npm >nul 2>nul
if errorlevel 1 (
  echo Install Node.js 24 LTS with npm, then run setup.cmd again.
  pause
  exit /b 1
)
call npm install
if errorlevel 1 (
  pause
  exit /b 1
)
echo Browser component installed. The application uses your installed Microsoft Edge.
echo Run start.cmd to open the procurement dashboard.
pause
