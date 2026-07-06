@echo off
setlocal
title AntlerOffice Installer Builder
cd /d "%~dp0"

echo ============================================
echo   AntlerOffice - Build Windows Installer
echo ============================================
echo.

where npm >nul 2>nul
if errorlevel 1 (
    echo [ERROR] npm not found. Please install Node.js first.
    pause
    exit /b 1
)

if exist ".git" (
    choice /c YN /t 10 /d N /m "Pull latest code from GitHub first? (auto-skip in 10s)"
    if not errorlevel 2 (
        echo.
        echo [Step 0] git pull...
        git pull
        if errorlevel 1 (
            echo [WARN] git pull failed, will continue with local code.
        )
        echo Updating dependencies...
        call npm install
    )
)

echo.
echo [Step 1] Building installer... (this takes a few minutes)
call npm run build:win
if errorlevel 1 (
    echo.
    echo ============ BUILD FAILED ============
    echo Common fixes:
    echo   1. If error mentions "Cannot create symbolic link" / winCodeSign:
    echo      - Enable Windows Developer Mode, OR right-click this bat
    echo        and "Run as administrator"
    echo      - Delete this folder, then run again:
    echo        %LOCALAPPDATA%\electron-builder\Cache\winCodeSign
    echo   2. Make sure scripts\strip-optional-natives.cjs still exists.
    echo.
    pause
    exit /b 1
)

echo.
echo [Step 2] Restoring better-sqlite3 for dev mode...
call npm rebuild better-sqlite3 >nul 2>nul

echo.
echo ============ BUILD SUCCESS ============
echo Newest installer in the "release" folder:
dir /b /o-d "release\AntlerOffice-Setup-*.exe" 2>nul
echo.
start "" explorer "%~dp0release"
pause
