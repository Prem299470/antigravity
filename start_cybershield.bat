@echo off
echo Starting CyberShield AI Background API Server...
start /b node wifi-api-server.js
echo.
echo Opening CyberShield AI Dashboard in your default browser...
timeout /t 2 /nobreak >nul
start index.html
echo.
echo CyberShield is running! You can now use the Wi-Fi Check to scan for connected devices.
echo Keep this window open while using the dashboard. To exit, close this window.
pause
