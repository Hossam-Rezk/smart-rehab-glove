@echo off
REM ============================================================
REM  Smart Rehabilitation Glove - start the website
REM  Double-click this file. The website opens in your browser.
REM  Keep this window open while you use the website.
REM ============================================================
setlocal
cd /d "%~dp0"
title Smart Rehab Glove - website

call "%~dp0scripts\setup_env.bat"
if errorlevel 1 (
  pause
  exit /b 1
)

"%VENV_PY%" backend\server.py
if errorlevel 1 (
  echo.
  echo [X] The server stopped with an error ^(see above^).
  echo     If it says the port is in use, close the other start.bat window.
)
pause
