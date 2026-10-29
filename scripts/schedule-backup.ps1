# Programa el respaldo diario de la base en el Programador de tareas de Windows.
#
#   pnpm db:backup:schedule            -> crea o actualiza la tarea (22:00)
#   pnpm db:backup:schedule -- 13:30   -> a otra hora
#
# No necesita administrador: la tarea corre con el usuario actual y solo cuando
# la sesion esta iniciada. Si a esa hora el equipo estaba apagado, corre en
# cuanto se enciende (StartWhenAvailable). La salida queda en
# %LOCALAPPDATA%\punto-venta\backups\respaldo.log.
param([string]$Hora = '22:00')

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node).Source
$log = Join-Path $env:LOCALAPPDATA 'punto-venta\backups\respaldo.log'
New-Item -ItemType Directory -Force (Split-Path $log) | Out-Null

# cmd /c para poder redirigir la salida al log. Comillas exteriores extra: con
# mas de dos comillas, cmd quita la primera y la ultima de toda la linea.
$cmd = "`"$node`" `"$root\scripts\backup-db.mjs`" --verify >> `"$log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument "/s /c `"$cmd`"" -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -Daily -At $Hora
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Minutes 30)

Register-ScheduledTask -TaskName 'PuntoVenta-Respaldo' -Action $action -Trigger $trigger `
  -Settings $settings -Description 'Respaldo diario de la base del punto de venta (pg_dump, conserva 14).' `
  -Force | Out-Null

Write-Host "Tarea 'PuntoVenta-Respaldo' programada a diario a las $Hora."
Write-Host "Log: $log"
