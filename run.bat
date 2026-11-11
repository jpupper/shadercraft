@echo off
setlocal
title ShaderCraft - Puerto 3255
set "PORT=3255"

echo [ShaderCraft] Liberando SOLO el puerto %PORT% (no toca otras apps)...
powershell -NoProfile -Command "$pids = Get-NetTCPConnection -LocalPort %PORT% -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique; if ($pids) { foreach ($p in $pids) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue; Write-Host ('  PID ' + $p + ' liberado (puerto %PORT%)') } } else { Write-Host '  Puerto %PORT% libre, nada que matar.' }"
ping -n 3 127.0.0.1 >nul

echo [ShaderCraft] Iniciando servidor multijugador...
npm run dev
pause

