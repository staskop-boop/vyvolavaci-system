# Aktualizácia servera AdNa z GitHubu (vetva main). Spúšťa ju úloha „AdNa aktualizácia“ každých 15 minút;
# nasadí len vtedy, keď je v GitHube nový commit. Pred aktualizáciou urobí zálohu databázy.
# Ručne (ako správca): powershell -ExecutionPolicy Bypass -File C:\AdNa\aktualizuj.ps1 -Vynutit
param([string]$Koren = "C:\AdNa", [string]$Vetva = "main", [switch]$Vynutit, [switch]$BezSpustenia)
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Repo = "staskop-boop/vyvolavaci-system"
$App = Join-Path $Koren "app"; $Data = Join-Path $Koren "data"; $Verzia = Join-Path $Koren "VERZIA.txt"
$node = "$env:ProgramFiles\nodejs\node.exe"; $npm = "$env:ProgramFiles\nodejs\npm.cmd"
$log = Join-Path $Koren "aktualizacia.log"
function Zapis($t) { "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $t" | Add-Content $log; Write-Host $t }

$hlavicky = @{ "User-Agent" = "adna-server" }
if ($env:GITHUB_TOKEN) { $hlavicky["Authorization"] = "Bearer $env:GITHUB_TOKEN" }
$sha = (Invoke-RestMethod "https://api.github.com/repos/$Repo/commits/$Vetva" -Headers $hlavicky).sha
$aktualna = if (Test-Path $Verzia) { (Get-Content $Verzia -Raw).Trim() } else { "" }
if (-not $Vynutit -and $sha -eq $aktualna) { return }
Zapis "Aktualizácia na $($sha.Substring(0,7))"

$tmp = Join-Path $env:TEMP "adna-$($sha.Substring(0,7))"
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
Invoke-WebRequest "https://github.com/$Repo/archive/$sha.zip" -OutFile "$tmp\kod.zip"
Expand-Archive "$tmp\kod.zip" -DestinationPath $tmp -Force
$novy = Get-ChildItem $tmp -Directory | Select-Object -First 1

# závislosti nainštalovať ešte pred zastavením servera (kratší výpadok)
Push-Location (Join-Path $novy.FullName "server")
& $npm ci --omit=dev --no-audit --no-fund 2>&1 | Out-Null
$npmKod = $LASTEXITCODE
Pop-Location
if ($npmKod -ne 0) { Zapis "⚠ npm ci zlyhalo ($npmKod) – ostáva doterajšia verzia"; return }

if (Test-Path (Join-Path $App "server\scripts\zaloha.js")) {
  $env:ADNA_DATA_DIR = $Data
  Push-Location (Join-Path $App "server")
  $vystup = (& $node --disable-warning=ExperimentalWarning scripts\zaloha.js 2>&1 | Out-String).Trim()
  $zKod = $LASTEXITCODE
  Pop-Location
  if ($zKod -eq 0) { Zapis $vystup } else { Zapis "⚠ Záloha zlyhala ($zKod): $vystup" }
}
Stop-ScheduledTask -TaskName "AdNa server" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*src\index.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Start-Sleep 2
$stary = "$App.stary"
Remove-Item $stary -Recurse -Force -ErrorAction SilentlyContinue
if (Test-Path $App) { Move-Item $App $stary }
Move-Item $novy.FullName $App
Set-Content $Verzia $sha
if (-not $BezSpustenia) { Start-ScheduledTask -TaskName "AdNa server" -ErrorAction SilentlyContinue }
Remove-Item $tmp, $stary -Recurse -Force -ErrorAction SilentlyContinue
Zapis "Hotovo: $($sha.Substring(0,7))"
