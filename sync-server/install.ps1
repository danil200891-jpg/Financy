# Financy Sync — first-time setup for Windows. Run: double-click «Установить Financy Sync.cmd».
# What it does (nothing else):
#   1. copies the server to %LOCALAPPDATA%\Financy-Sync\app
#   2. creates the backup folder (default D:\CODEX\Financy\Backups; a re-install keeps the folder
#      already in use unless -BackupDir is given) readable only by you
#   3. adds a start-up entry for your user (no system service, no admin rights)
#   4. OPTIONAL, only if you answer «Y»: a Windows Firewall rule for ports 47820-47821, private networks only
#   5. starts the server and opens its page
# Nothing is deleted. Existing data and backups are kept.
# -NoAutostart (for checks): no start-up entry and no browser window
param([string]$BackupDir = 'D:\CODEX\Financy\Backups', [switch]$NoFirewall, [switch]$NoStart, [switch]$NoAutostart)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$home2 = Join-Path $env:LOCALAPPDATA 'Financy-Sync'
$app = Join-Path $home2 'app'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
Say "`nFinancy Sync — установка`n" Cyan

# 1. Node.js
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Say 'Не найден Node.js. Установите Node.js 22 или новее с https://nodejs.org и запустите установку снова.' Red; exit 1 }
# parse "v24.1.0" ourselves: Windows PowerShell 5.1 strips quotes from native arguments
$ver = 0
if ((& $node --version) -match '^v(\d+)\.') { $ver = [int]$Matches[1] }
if ($ver -lt 22) { Say "Нужен Node.js 22 или новее (сейчас $ver)." Red; exit 1 }

# openssl (ships with Git for Windows)
$openssl = $null
$candidates = @((Get-Command openssl -ErrorAction SilentlyContinue).Source)
# Git may live anywhere (e.g. D:\Tools\Git): derive <Git>\usr\bin\openssl.exe from git.exe
$git = (Get-Command git -ErrorAction SilentlyContinue).Source
if ($git) {
  $gitRoot = Split-Path (Split-Path $git -Parent) -Parent
  $candidates += @((Join-Path $gitRoot 'usr\bin\openssl.exe'), (Join-Path $gitRoot 'mingw64\bin\openssl.exe'))
}
$candidates += @("$env:ProgramFiles\Git\usr\bin\openssl.exe", "$env:ProgramFiles\Git\mingw64\bin\openssl.exe", "$env:LOCALAPPDATA\Programs\Git\usr\bin\openssl.exe")
foreach ($c in $candidates) {
  if ($c -and (Test-Path $c)) { $openssl = $c; break }
}
if (-not $openssl) { Say 'Не найден openssl. Установите Git for Windows (https://git-scm.com) и запустите установку снова.' Red; exit 1 }

# stop a running copy before updating its files
try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47822/api/stop' -Headers @{ 'X-Financy-Admin' = '1' } -TimeoutSec 3 | Out-Null; Start-Sleep 2 } catch { }

# 2. files
New-Item -ItemType Directory -Force -Path $app, (Join-Path $app 'lib') | Out-Null
Copy-Item -Force (Join-Path $src '*.mjs'), (Join-Path $src 'admin.html') $app
Copy-Item -Force (Join-Path $src 'lib\*.mjs') (Join-Path $app 'lib')
Say "Сервер скопирован в $app" Green

# 3. backup folder. A re-install keeps the folder the server already uses (unless -BackupDir is given),
#    so copies are never silently split between two folders.
$cfgPath = Join-Path $home2 'config.json'
if (-not $PSBoundParameters.ContainsKey('BackupDir') -and (Test-Path $cfgPath)) {
  try { $prev = (Get-Content -Raw -Encoding UTF8 $cfgPath | ConvertFrom-Json).payload.backupDir; if ($prev) { $BackupDir = $prev } } catch { }
}
# no drive D: -> Documents\Financy-Backups
if (-not (Test-Path (Split-Path -Qualifier $BackupDir))) {
  $BackupDir = Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Financy-Backups'
  Say "Диска D: нет — копии будут в $BackupDir" Yellow
}
$created = -not (Test-Path $BackupDir)
New-Item -ItemType Directory -Force -Path $BackupDir | Out-Null
if ($created) {
  # only you (and Windows itself) can read the financial copies
  & icacls $BackupDir /inheritance:r /grant:r "${env:USERNAME}:(OI)(CI)F" "SYSTEM:(OI)(CI)F" | Out-Null
}
Say "Папка резервных копий: $BackupDir" Green

# server config: keep existing serverId and devices, only set paths
& $node (Join-Path $app 'write-config.mjs') $cfgPath $BackupDir $openssl
if ($LASTEXITCODE -ne 0) { Say "Не удалось записать настройки $cfgPath" Red; exit 1 }

# 4. start-up entry (current user only)
$vbs = Join-Path $app 'start-hidden.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """$node"" ""$app\supervisor.mjs""", 0, False
"@ | Set-Content -Encoding ASCII $vbs
if (-not $NoAutostart) {
  $startup = [Environment]::GetFolderPath('Startup')
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'Financy Sync.lnk'))
  $lnk.TargetPath = 'wscript.exe'; $lnk.Arguments = "`"$vbs`""; $lnk.WorkingDirectory = $app; $lnk.Description = 'Financy Sync'; $lnk.Save()
  Say 'Автозапуск при входе в Windows включён.' Green
}

# 5. firewall (optional, needs administrator approval)
if (-not $NoFirewall) {
  $existing = Get-NetFirewallRule -DisplayName 'Financy Sync' -ErrorAction SilentlyContinue
  if ($existing) { Say 'Правило брандмауэра Financy Sync уже есть.' Green }
  else {
    Say "`nЧтобы iPhone видел компьютер, нужно разрешить входящие подключения на порты 47820-47821 в ЧАСТНЫХ сетях." Yellow
    $a = Read-Host 'Добавить правило брандмауэра? Windows попросит подтверждение администратора (Y/N)'
    if ($a -match '^[YyДд]') {
      $cmd = "New-NetFirewallRule -DisplayName 'Financy Sync' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 47820,47821 -Profile Private | Out-Null"
      Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', $cmd
      if (Get-NetFirewallRule -DisplayName 'Financy Sync' -ErrorAction SilentlyContinue) { Say 'Правило добавлено.' Green } else { Say 'Правило не добавлено. Его можно добавить позже, запустив установку снова.' Yellow }
    }
  }
  $profiles = Get-NetConnectionProfile -ErrorAction SilentlyContinue | Where-Object { $_.IPv4Connectivity -ne 'Disconnected' }
  foreach ($p in $profiles) {
    if ($p.NetworkCategory -eq 'Public') { Say "Внимание: сеть «$($p.Name)» помечена как общедоступная. В «Параметры → Сеть и Интернет → Wi-Fi → свойства сети» выберите «Частная сеть», иначе iPhone не подключится." Yellow }
  }
  $blocks = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*node.exe' } | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Action -eq 'Block' -and $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }
  if ($blocks) { Say "Внимание: есть запрещающие правила брандмауэра для node.exe ($(@($blocks).Count)). Они сильнее разрешающих. Проверьте их в «Брандмауэр Защитника Windows → Дополнительные параметры → Правила для входящих подключений» (Node.js JavaScript Runtime)." Yellow }
}

# 6. start
if (-not $NoStart) {
  Start-Process wscript.exe -ArgumentList "`"$vbs`""
  $ok = $false
  for ($i = 0; $i -lt 30 -and -not $ok; $i++) { Start-Sleep -Milliseconds 500; try { Invoke-RestMethod 'http://127.0.0.1:47822/api/status' -Headers @{ 'X-Financy-Admin' = '1' } -TimeoutSec 2 | Out-Null; $ok = $true } catch { } }
  if ($ok) { Say "`nГотово. Страница сервера: http://127.0.0.1:47822/" Cyan; if (-not $NoAutostart) { Start-Process 'http://127.0.0.1:47822/' } }
  else { Say "Сервер не ответил. Журнал: $home2\logs\server.log" Red; exit 1 }
}
