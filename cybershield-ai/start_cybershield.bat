@echo off
title CyberShield AI Launcher
echo.
echo  ====================================
echo    CyberShield AI — Starting Up...
echo  ====================================
echo.

:: Start the integrated local app server in background
echo  [1/3] Starting integrated local server...
start /b node "%~dp0server.js"

:: Wait up to 5 seconds for the port to open
echo  [2/3] Waiting for scanner to be ready...
set /a tries=0
:wait_loop
timeout /t 1 /nobreak >nul
set /a tries+=1
powershell -NoProfile -Command "try { $r=(Invoke-WebRequest http://127.0.0.1:4318/health -TimeoutSec 1 -UseBasicParsing).StatusCode; if($r -eq 200){exit 0} } catch { exit 1 }" >nul 2>&1
if %errorlevel%==0 goto server_ready
if %tries% geq 5 goto open_anyway
goto wait_loop

:server_ready
echo  [2/3] Scanner is online (port 4318) ✓

:open_anyway
echo  [3/3] Opening CyberShield AI dashboard...
start "" "http://127.0.0.1:4318/"
echo.
echo  CyberShield AI is running!
echo  Keep this window open while using the dashboard.
echo  Press any key to stop the server and exit.
echo.
pause >nul
taskkill /f /im node.exe >nul 2>&1
echo  Server stopped. Goodbye!
