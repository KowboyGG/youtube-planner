@echo off
title YouTube planer
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js is not installed. Download it from https://nodejs.org and run this file again.
  echo.
  pause
  exit /b 1
)
rem when downloading, the hyphen may disappear from the name - accept both variants
set "SERVER=%~dp0planer-server.js"
if not exist "%SERVER%" set "SERVER=%~dp0planerserver.js"
if not exist "%SERVER%" (
  echo.
  echo   planer-server.js not found. Put it in the same folder as this file.
  echo.
  pause
  exit /b 1
)
node "%SERVER%"
if errorlevel 1 pause
