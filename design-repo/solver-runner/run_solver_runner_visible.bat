@echo off
setlocal

set "SOLVER_RUNNER_DIR=%~dp0"
set "REPO_ROOT=%SOLVER_RUNNER_DIR%..\.."
set "RUNNER=%SOLVER_RUNNER_DIR%.venv\Scripts\pi-solver-runner.exe"
set "WORK_DIR=%SOLVER_RUNNER_DIR%jobs"

if not exist "%RUNNER%" (
  call "%SOLVER_RUNNER_DIR%bootstrap_solver_runner.bat"
  if errorlevel 1 (
    pause
    exit /b 1
  )
)

if not exist "%RUNNER%" (
  set "RUNNER=%REPO_ROOT%\.venv\Scripts\pi-solver-runner.exe"
)

if not exist "%WORK_DIR%" mkdir "%WORK_DIR%"

echo Starting PI Solver Runner in this window...
echo URL: http://0.0.0.0:17890
echo Work dir: %WORK_DIR%
echo.
echo Keep this window open while using the service.
echo Press Ctrl+C to stop.
echo.

"%RUNNER%" --host 0.0.0.0 --port 17890 --work-dir "%WORK_DIR%"

echo.
echo PI Solver Runner exited.
pause
