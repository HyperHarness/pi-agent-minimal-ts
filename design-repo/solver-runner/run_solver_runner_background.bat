@echo off
setlocal

set "SOLVER_RUNNER_DIR=%~dp0"
set "REPO_ROOT=%SOLVER_RUNNER_DIR%..\.."
set "RUNNER=%SOLVER_RUNNER_DIR%.venv\Scripts\pi-solver-runner.exe"
set "WORK_DIR=%SOLVER_RUNNER_DIR%jobs"
set "LOG_DIR=%SOLVER_RUNNER_DIR%logs"
set "OUT_LOG=%LOG_DIR%\runner.out.log"
set "ERR_LOG=%LOG_DIR%\runner.err.log"

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
if not exist "%LOG_DIR%" mkdir "%LOG_DIR%"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = Start-Process -FilePath '%RUNNER%' -ArgumentList '--host','0.0.0.0','--port','17890','--work-dir','%WORK_DIR%' -WorkingDirectory '%SOLVER_RUNNER_DIR%' -RedirectStandardOutput '%OUT_LOG%' -RedirectStandardError '%ERR_LOG%' -WindowStyle Hidden -PassThru; Write-Host ('PI Solver Runner started in background. PID: ' + $p.Id); Write-Host 'URL: http://0.0.0.0:17890'; Write-Host 'Logs:'; Write-Host '  %OUT_LOG%'; Write-Host '  %ERR_LOG%'"

echo.
echo To check whether it is listening:
echo   powershell -NoProfile -Command "Get-NetTCPConnection -LocalPort 17890 -State Listen"
echo.
pause
