@echo off
REM ============================================================
REM  Shared helper for setup_pico.bat and start.bat.
REM  1. Finds a Python 3.10+ that has pip (skips Pythons without
REM     pip, such as the MSYS2 one).
REM  2. Creates a private environment in the .venv folder.
REM  3. Installs the packages from requirements.txt into it, and
REM     installs again whenever requirements.txt changes.
REM  Afterwards VENV_PY points to the Python to use.
REM ============================================================
set "ROOT=%~dp0.."
set "VENV_PY=%ROOT%\.venv\Scripts\python.exe"
set "REQ=%ROOT%\requirements.txt"
set "STAMP=%ROOT%\.venv\installed-requirements.txt"

if exist "%VENV_PY%" goto :check_packages

set "BASE_PY="
for %%C in ("py -3" "python" "python3") do (
  if not defined BASE_PY (
    %%~C -c "import sys, pip, venv; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "BASE_PY=%%~C"
  )
)
if not defined BASE_PY (
  echo [X] No suitable Python was found ^(Python 3.10 or newer, with pip^).
  echo     Install Python from https://www.python.org/downloads/
  echo     and tick "Add python.exe to PATH" during installation.
  exit /b 1
)

echo Creating a private Python environment ^(first time only^)...
%BASE_PY% -m venv "%ROOT%\.venv"
if errorlevel 1 (
  echo [X] Could not create the Python environment in "%ROOT%\.venv".
  exit /b 1
)

:check_packages
fc /b "%REQ%" "%STAMP%" >nul 2>nul
if not errorlevel 1 exit /b 0

echo Installing the needed Python packages ^(first time can take a few minutes^)...
"%VENV_PY%" -m pip install --disable-pip-version-check -q -r "%REQ%"
if errorlevel 1 (
  echo [X] Could not install the packages. Check the internet connection and try again.
  exit /b 1
)
copy /y "%REQ%" "%STAMP%" >nul
exit /b 0
