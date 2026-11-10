# Financy Sync 1.1 update procedure (not executed)

The development source advertises `planning-v2`. The existing installed 1.0 server can sync operations, clients and categories, but cannot confirm reserve commands. Publishing the PWA does not update Windows software. Pending commands stay on the phone until a compatible server is reachable; no second user approval is needed for an ordinary valid command.

## Before separately approved installation

1. Export a JSON backup on the iPhone and verify the file can be read. Do not remove the app or change its origin. Record operation/client counts and pending reserves.
2. In the existing PC admin page create and verify a manual backup. Record the server version, server ID, paired devices and configured backup directory. Do not expose these files or credentials in Git.
3. Stop Sync with its admin page's **Остановить сервер** action. Confirm its listener and supervisor have stopped before copying mutable files.
4. Copy the entire `%LOCALAPPDATA%\Financy-Sync` directory, including `app`, `config.json`, `devices.json`, `sync-db.json`, `state.json` and `tls`, to a new private recovery folder outside Git. Verify the copied files' SHA-256 hashes. Preserve the existing backup folder separately; do not move it or change its path.

## In-place update after permission

Use the existing installer from the tested planning worktree as an in-place code update, without uninstalling or unpairing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\CODEX\Financy\.worktrees\planning\sync-server\install.ps1" -NoFirewall
```

Do not pass `-BackupDir`: the installer preserves the configured path. It updates application files in the same location and keeps the server identity, devices, database and TLS certificates. Keep the recovery snapshot. If any identity/path/count changes unexpectedly, stop and investigate before allowing devices to reconnect.

Verify version 1.1.0 and `planning-v2`, the same server ID/backup path and paired devices. Open Financy in the foreground on home Wi-Fi. Valid pending reserves should confirm automatically; retrying an already accepted command must not reserve twice. Check actual balance, reserve/free totals and operation/client counts; reserve movements must not create income/expense. Verify a new manual backup contains planning. A genuine insufficient-funds conflict stays visible for review.

## Recovery

On failure, stop the updated server and preserve its entire directory in another private snapshot. Do not overwrite or delete newly acknowledged financial data. If no new writes were acknowledged, the verified pre-update application files can be restored in place and started with the existing launcher. Keep all financial/configuration files. If new writes were acknowledged, keep the new database and stop for a reviewed recovery plan; do not blindly restore an older database. The phone remains usable offline.

## iPhone PWA update

After a separately approved publication, open the existing installed app with internet, wait for **Доступна новая версия**, then tap **Обновить**. Alternatively use **Настройки → Обновления приложения**. Save open forms first. No reinstall, IndexedDB reset or new home-screen icon is needed. iOS does not guarantee checks while the app is closed; checks run on launch/foreground/reconnect and hourly while visible.
