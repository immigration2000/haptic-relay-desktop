@echo off
chcp 65001 >nul
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\scripts\start-hardware-demo.ps1"
set "RESULT=%ERRORLEVEL%"
echo.
if "%RESULT%"=="0" (
  echo Demo windows and local relay are running.
) else (
  echo Demo startup failed.
)
pause
exit /b %RESULT%
