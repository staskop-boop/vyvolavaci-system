# Zruší automatické spúšťanie agenta. Konfiguráciu, denník a profil prehliadača ponechá (%ProgramData%\AdNa\vrp2-agent).
Stop-ScheduledTask -TaskName "AdNa VRP2 agent" -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName "AdNa VRP2 agent" -Confirm:$false -ErrorAction SilentlyContinue
Write-Host "Agent už sa nebude spúšťať. Údaje ostali v $env:ProgramData\AdNa\vrp2-agent."
