# Financy Sync — switch off. Stops the server and removes the start-up entry.
# Data (%LOCALAPPDATA%\Financy-Sync) and backups (D:\CODEX\Financy\Backups) are NOT deleted.
$ErrorActionPreference = 'Continue'
try { Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:47822/api/stop' -Headers @{ 'X-Financy-Admin' = '1' } -TimeoutSec 3 | Out-Null; Write-Host 'Сервер остановлен.' -ForegroundColor Green } catch { Write-Host 'Сервер не был запущен.' }
$lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Financy Sync.lnk'
if (Test-Path $lnk) { Remove-Item $lnk; Write-Host 'Автозапуск выключен.' -ForegroundColor Green }
if (Get-NetFirewallRule -DisplayName 'Financy Sync' -ErrorAction SilentlyContinue) {
  $a = Read-Host 'Удалить правило брандмауэра Financy Sync? Нужно подтверждение администратора (Y/N)'
  if ($a -match '^[YyДд]') { Start-Process powershell -Verb RunAs -Wait -ArgumentList '-NoProfile', '-Command', "Remove-NetFirewallRule -DisplayName 'Financy Sync'" }
}
Write-Host "Данные и резервные копии сохранены: $env:LOCALAPPDATA\Financy-Sync и папка копий."
