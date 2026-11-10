# Financy Sync — connection check. Prints what works and what to fix. Changes nothing.
function Line($ok, $t) { if ($ok) { Write-Host "  OK   $t" -ForegroundColor Green } else { Write-Host "  !!   $t" -ForegroundColor Yellow } }
Write-Host "`nFinancy Sync — диагностика`n" -ForegroundColor Cyan
$s = $null
try { $s = Invoke-RestMethod 'http://127.0.0.1:47822/api/status' -Headers @{ 'X-Financy-Admin' = '1' } -TimeoutSec 3 } catch { }
Line ($null -ne $s) ($(if ($s) { "Сервер работает, версия $($s.version)" } else { 'Сервер не отвечает. Запустите установку снова или войдите в Windows заново.' }))
$listen = Get-NetTCPConnection -State Listen -LocalPort 47821 -ErrorAction SilentlyContinue
Line ($null -ne $listen) 'Порт 47821 (синхронизация) открыт'
$ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -match '^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))' }
Line ($null -ne $ips) ("Адреса в локальной сети: " + (($ips | ForEach-Object IPAddress) -join ', '))
if ($s) { Write-Host "       Имя для iPhone: $($s.hosts[0])" }
$rule = Get-NetFirewallRule -DisplayName 'Financy Sync' -ErrorAction SilentlyContinue
Line ($null -ne $rule) 'Правило брандмауэра Financy Sync'
foreach ($p in (Get-NetConnectionProfile -ErrorAction SilentlyContinue)) { Line ($p.NetworkCategory -ne 'Public') "Сеть «$($p.Name)»: $($p.NetworkCategory)" }
$blocks = Get-NetFirewallApplicationFilter -ErrorAction SilentlyContinue | Where-Object { $_.Program -like '*node.exe' } | Get-NetFirewallRule -ErrorAction SilentlyContinue | Where-Object { $_.Action -eq 'Block' -and $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' }
Line (-not $blocks) 'Нет запрещающих правил для node.exe'
if ($s) {
  Line ($s.devices | Where-Object { -not $_.revoked }) "Подключённых устройств: $(@($s.devices | Where-Object { -not $_.revoked }).Count)"
  Line (-not $s.state.lastBackupError) "Последняя копия: $($s.state.lastBackupAt) $($s.state.lastBackupError)"
}
Write-Host "`nЖурнал: $env:LOCALAPPDATA\Financy-Sync\logs\server.log`n"
