@echo off
REM ============================================================
REM  Smart Rehabilitation Glove - start the website
REM  Double-click this file. The website opens in your browser.
REM  Keep this window open while you use the website.
REM ============================================================
setlocal
cd /d "%~dp0"
title Smart Rehab Glove - website

where python >nul 2>nul
if errorlevel 1 (
  echo [X] Python was not found.
  echo     Install Python 3.11 or newer from https://www.python.org/downloads/
  echo     and tick "Add python.exe to PATH" during installation.
  pause
  exit /b 1
)

echo Checking Python packages...
python -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 (
  echo [!] Could not install packages. Trying to start anyway...
)

python backend\server.py
if errorlevel 1 (
  echo.
  echo [X] The server stopped with an error ^(see above^).
  echo     If it says the port is in use, close the other start.bat window.
)
pause
