@echo off
rem SPDX-License-Identifier: GPL-3.0-or-later
rem Copyright (C) 2026 TechFlow IT
setlocal
title Folderpost
cd /d "%~dp0"

set NODE_EXE=%~dp0runtime\node-win-x64\node.exe

if exist "%NODE_EXE%" (
  echo Using the bundled Node.js from runtime\node-win-x64
  set "RUN_NODE=%NODE_EXE%"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo.
    echo [ERROR] Node.js was not found.
    echo.
    echo Either install Node.js system-wide ^(https://nodejs.org, LTS version^)
    echo or place the portable version in this folder, see runtime\README.txt
    echo.
    pause
    exit /b 1
  )
  set "RUN_NODE=node"
)

echo Starting Folderpost ...
echo Open http://%COMPUTERNAME%:3000 (and http://localhost:3000 on this computer)
echo Keep this window open while Folderpost should run. To stop: Ctrl+C.
"%RUN_NODE%" server.js
pause
