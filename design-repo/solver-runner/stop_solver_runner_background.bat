@echo off
setlocal

set "PORT=17890"

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$connections = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if (-not $connections) { Write-Host 'PI Solver Runner is not listening on port %PORT%.'; exit 0 }; $pids = $connections | Select-Object -ExpandProperty OwningProcess -Unique; foreach ($pidValue in $pids) { $proc = Get-Process -Id $pidValue -ErrorAction SilentlyContinue; if ($proc) { Write-Host ('Stopping PI Solver Runner process. PID: ' + $pidValue + ', Name: ' + $proc.ProcessName); Stop-Process -Id $pidValue -Force } }; Start-Sleep -Milliseconds 500; $remaining = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue; if ($remaining) { Write-Host 'WARNING: port %PORT% is still listening.'; exit 1 } else { Write-Host 'PI Solver Runner stopped.' }"

echo.
pause
