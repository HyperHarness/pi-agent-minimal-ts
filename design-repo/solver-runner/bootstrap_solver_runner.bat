@echo off
setlocal

set "SOLVER_RUNNER_DIR=%~dp0"
set "PYTHON=%SOLVER_RUNNER_DIR%.venv\Scripts\python.exe"
set "RUNNER=%SOLVER_RUNNER_DIR%.venv\Scripts\pi-solver-runner.exe"

if not exist "%SOLVER_RUNNER_DIR%pyproject.toml" (
  echo ERROR: pyproject.toml not found in:
  echo   %SOLVER_RUNNER_DIR%
  exit /b 1
)

if not exist "%PYTHON%" (
  echo Creating local virtual environment...
  py -3.11 -m venv "%SOLVER_RUNNER_DIR%.venv"
  if errorlevel 1 (
    echo ERROR: failed to create .venv with py -3.11.
    echo Install Python 3.11 or make sure the Python launcher is available.
    exit /b 1
  )
)

if not exist "%RUNNER%" (
  echo Installing pi-solver-runner into local virtual environment...
  "%PYTHON%" -m pip install --upgrade pip
  if errorlevel 1 exit /b 1
  "%PYTHON%" -m pip install -e "%SOLVER_RUNNER_DIR%."
  if errorlevel 1 exit /b 1
)

if not exist "%RUNNER%" (
  echo ERROR: runner executable was not created:
  echo   %RUNNER%
  exit /b 1
)

exit /b 0
