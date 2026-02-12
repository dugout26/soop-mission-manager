@echo off
title SOOP 대결미션 매니저
echo.
echo  ==============================
echo   SOOP 대결미션 매니저 시작
echo  ==============================
echo.
cd /d "%~dp0"
start http://localhost:3000
node server.js
pause
