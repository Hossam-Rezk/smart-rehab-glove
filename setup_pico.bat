@echo off
REM ============================================================
REM  Smart Rehabilitation Glove - one-click Pico setup
REM  Double-click this file with the Pico plugged in by USB.
REM  It installs the tools and copies the glove program to the Pico.
REM ============================================================
setlocal
cd /d "%~dp0"
title Smart Rehab Glove - Pico setup

echo.
echo === Smart Rehabilitation Glove : Pico setup ===
echo.

where python >nul 2>nul
if errorlevel 1 (
  echo [X] Python was not found.
  echo     Install Python 3.11 or newer from https://www.python.org/downloads/
  echo     and tick "Add python.exe to PATH" during installation.
  goto :fail
)

echo [1/3] Installing the needed Python packages (first time can take a minute)...
python -m pip install --disable-pip-version-check -q -r requirements.txt
if errorlevel 1 (
  echo [X] Could not install the packages. Check the internet connection.
  goto :fail
)

echo [2/3] Looking for the Pico... (close Thonny if it is open)
python -m mpremote connect auto exec "import sys; print('Found:', sys.implementation._machine)"
if errorlevel 1 (
  echo.
  echo [X] No Pico with MicroPython was found.
  echo     1. Close Thonny and the glove website.
  echo     2. Check the USB cable ^(it must be a DATA cable^).
  echo     3. If the Pico is new or erased, install MicroPython first:
  echo        hold the BOOTSEL button, plug in the USB cable, release the button,
  echo        then copy the Pico 2 W .uf2 file from
  echo        https://micropython.org/download/RPI_PICO2_W/  onto the RP2350 drive.
  echo     Then run this file again.
  goto :fail
)

echo [3/3] Copying the glove program to the Pico...
python -m mpremote connect auto cp pico\config.py :config.py + cp pico\main.py :main.py + reset
if errorlevel 1 (
  echo [X] Copying failed. Unplug the Pico, plug it back in, and try again.
  goto :fail
)

echo.
echo === Done! The Pico is ready. ===
echo You should hear one short beep from the glove.
echo Now double-click start.bat to open the website.
echo.
pause
exit /b 0

:fail
echo.
pause
exit /b 1
