# Financy Sync — first-time setup for Windows. Run: double-click «Установить Financy Sync.cmd».
# What it does (nothing else):
#   1. copies the server to %LOCALAPPDATA%\Financy-Sync\app
#   2. creates the backup folder (default D:\Financy-Backups) readable only by you
#   3. adds a start-up entry for your user (no system service, no admin rights)
#   4. OPTIONAL, only if you answer «Y»: a Windows Firewall rule for ports 47820-47821, private networks only
#   5. starts the server and opens its page
# Nothing is deleted. Existing data and backups are kept.
param([string]$BackupDir = 'D:\Financy-Backups', [switch]$NoFirewall, [switch]$NoStart)
$ErrorActionPreference = 'Stop'
$src = $PSScriptRoot
$home2 = Join-Path $env:LOCALAPPDATA 'Financy-Sync'
$app = Join-Path $home2 'app'

function Say($t, $c = 'Gray') { Write-Host $t -ForegroundColor $c }
Say "`nFinancy Sync — установка`n" Cyan

# 1. Node.js
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Say 'Не найден Node.js. Установите Node.js 22 или новее с https://nodejs.org и запустите установку снова.' Red; exit 1 }
$ver = [int]((& $node -p 'process.versions.node.split(".")[0]'))
if ($ver -lt 22) { Say "Нужен Node.js 22 или новее (сейчас $ver)." Red; exit 1 }

# openssl (ships with Git for Windows)
$openssl = $null
foreach ($c in @((Get-Command openssl -ErrorAction SilentlyContinue).Source, 'C:\Program Files\Git\usr\bin\openssl.exe', 'C:\Program Files\Git\mingw64\bin\openssl.exe')) {
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

# 3. backup folder: D:\Financy-Backups (falls back to Documents if there is no drive D:)
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
$cfgPath = Join-Path $home2 'config.json'
& $node -e "
const f=require('fs'),c=require('crypto'),p=process.argv[1];
const canon=v=>v===null||typeof v!=='object'?JSON.stringify(v):Array.isArray(v)?'['+v.map(canon).join(',')+']':'{'+Object.keys(v).filter(k=>v[k]!==undefined).sort().map(k=>JSON.stringify(k)+':'+canon(v[k])).join(',')+'}';
let cfg={};try{cfg=JSON.parse(f.readFileSync(p,'utf8')).payload||{}}catch{}
cfg.backupDir=process.argv[2];cfg.openssl=process.argv[3];
if(f.existsSync(p))f.copyFileSync(p,p+'.prev');
f.writeFileSync(p,JSON.stringify({sha256:c.createHash('sha256').update(canon(cfg)).digest('hex'),payload:cfg}));
" $cfgPath $BackupDir $openssl

# 4. start-up entry (current user only)
$vbs = Join-Path $app 'start-hidden.vbs'
@"
Set sh = CreateObject("WScript.Shell")
sh.Run """$node"" ""$app\supervisor.mjs""", 0, False
"@ | Set-Content -Encoding ASCII $vbs
$startup = [Environment]::GetFolderPath('Startup')
$lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $startup 'Financy Sync.lnk'))
$lnk.TargetPath = 'wscript.exe'; $lnk.Arguments = "`"$vbs`""; $lnk.WorkingDirectory = $app; $lnk.Description = 'Financy Sync'; $lnk.Save()
Say 'Автозапуск при входе в Windows включён.' Green

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
  if ($ok) { Say "`nГотово. Открываю страницу сервера…" Cyan; Start-Process 'http://127.0.0.1:47822/' }
  else { Say "Сервер не ответил. Журнал: $home2\logs\server.log" Red; exit 1 }
}
