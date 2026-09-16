@echo off
setlocal
cd /d "%~dp0"

echo ========================================
echo   Word Kingdom - Build 2074 Wordbook
echo ========================================
echo.

where node >nul 2>nul
if errorlevel 1 goto NODE_MISSING

node --version
if errorlevel 1 goto NODE_BAD

echo.
echo Build started...
echo Step 1: load word list
echo Step 2: fetch Etymonline CN etymology
echo Step 3: clean and deduplicate
echo Step 4: generate wordbook.js
echo.

node build-wordbook.mjs --workers 2 --delay 800
if errorlevel 1 goto BUILD_FAILED

echo.
echo BUILD COMPLETE: wordbook.js
pause
exit /b 0

:NODE_MISSING
echo ERROR: Node.js was not found.
echo Please install Node.js 20 or newer, then run this file again.
pause
exit /b 1

:NODE_BAD
echo ERROR: Node.js could not be started.
pause
exit /b 1

:BUILD_FAILED
echo.
echo BUILD FAILED.
echo Check your internet connection and .wordbook-cache\build-report.json
pause
exit /b 1
