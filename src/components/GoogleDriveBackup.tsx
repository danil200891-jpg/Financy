import { useEffect, useState } from 'react'
import { Cloud, Download, Link, RefreshCw, Unplug } from 'lucide-react'
import { Card } from './ui'
import type { Backup } from '../lib/backup'
import type { DriveFile } from '../lib/google-drive'
import { connectDrive, selectDriveFolder, disconnectDrive, downloadDriveBackup, driveConfigured, finishDriveRestore, listDriveBackups, prepareDrive, saveDriveBackup, useDriveBackup } from '../lib/drive-backup'
import { PICKER_KEY } from '../lib/google-picker'
import { FOLDER_ID } from '../lib/google-drive'

const dateTime = (date: string) => new Date(date).toLocaleString('ru-RU')

export function GoogleDriveBackup({ onRestore }: { onRestore: (backup: Backup) => void }) {
  const drive = useDriveBackup()
  const [files, setFiles] = useState<DriveFile[] | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    void prepareDrive()
    return finishDriveRestore
  }, [])

  const openBackups = async () => {
    setLoading(true)
    try { setFiles(await listDriveBackups()) } catch { /* The shared status displays the error. */ }
    finally { setLoading(false) }
  }

  const selectBackup = async (file: DriveFile) => {
    setLoading(true)
    try {
      const backup = await downloadDriveBackup(file.id, file.revisionId)
      setFiles(null)
      onRestore(backup)
    } catch { /* Keep the list open so another file can be selected. */ }
    finally { setLoading(false) }
  }

  const closeBackups = () => { setFiles(null); finishDriveRestore() }

  return (
    <section>
      <p className="mb-2 px-1 text-[15px] font-medium text-mist">Google Drive</p>
      <Card className="overflow-hidden">
        <div className="space-y-2 px-4 py-3.5 text-[14px] text-mist" aria-live="polite">
          <p className="flex items-center gap-3"><Cloud size={20} className="shrink-0 text-iris" />
            {drive.busy ? drive.connected ? 'Сохраняем копию…' : 'Подключение…' : drive.connected ? 'Автокопирование подключено' : drive.enabled ? 'Требуется повторное подключение' : 'Автокопирование отключено'}
          </p>
          {drive.lastSuccess && <p>Последнее сохранение {dateTime(drive.lastSuccess)}</p>}
          <p>Папка Financy Backup. Одна копия за календарный день, обновляемая через 5 секунд после изменений. Хранятся последние 30 календарных дней; старые ежедневные копии переносятся в корзину только после проверки новой.</p>
          <p className="break-all text-[12px]">Folder ID: {FOLDER_ID}</p>
          {drive.folderId && <p className="text-income">Доступ к указанной папке подтверждён</p>}
          <p>Автокопирование работает при открытом приложении и наличии интернета. После офлайн-изменений повторится при подключении или следующем входе.</p>
          <p>После перезапуска или истечения доступа Google потребуется подключение. Операции при этом остаются на устройстве.</p>
          {drive.error && <p className="text-amber" role="alert">{drive.error}</p>}
        </div>
        <div className="divide-y divide-line border-t border-line">
          {!drive.connected && <button disabled={!drive.ready || drive.busy || !driveConfigured} onClick={connectDrive} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left text-[16px] disabled:opacity-40">
            <Link size={20} className="text-iris" /> {drive.ready ? 'Подключить Google Drive' : driveConfigured ? 'Загрузка Google OAuth…' : 'Google Drive не настроен'}
          </button>}
          {!drive.ready && driveConfigured && <button onClick={() => { void prepareDrive() }} className="press w-full px-4 py-3 text-left text-[14px] text-iris">Повторить загрузку Google OAuth</button>}
          {drive.connected && <>
            {drive.folderRequired && <>
              {PICKER_KEY ? <button disabled={drive.busy || loading} onClick={() => { void selectDriveFolder() }} className="press w-full px-4 py-3 text-left text-[16px] text-iris">Выбрать папку через Google Picker</button> : <p className="px-4 py-3 text-[14px] text-amber">Отсутствует VITE_GOOGLE_PICKER_API_KEY проекта financy-backup для однократного выбора этой папки. Google Picker API должен быть включён в том же проекте. Полный доступ к Drive не требуется.</p>}
            </>}
            <button disabled={drive.busy || loading} onClick={() => { void saveDriveBackup() }} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left text-[16px] disabled:opacity-40"><RefreshCw size={20} className="text-iris" /> Сохранить сейчас</button>
            <button disabled={drive.busy || loading} onClick={() => { void openBackups() }} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left text-[16px] disabled:opacity-40"><Download size={20} className="text-iris" /> Восстановить из Google Drive</button>
          </>}
          {drive.enabled && <button onClick={() => { void disconnectDrive() }} className="press flex w-full items-center gap-3.5 px-4 py-3.5 text-left text-[16px]"><Unplug size={20} className="text-iris" /> Отключить Google Drive</button>}
        </div>
      </Card>
      {files && <div className="anim-fade fixed inset-0 z-[75] grid place-items-center bg-black/60 px-6" onClick={loading ? undefined : closeBackups}>
        <div role="dialog" aria-modal="true" aria-label="Копии в Google Drive" className="glass-strong max-h-[80vh] w-full max-w-[340px] overflow-y-auto rounded-[26px] p-5" onClick={(event) => event.stopPropagation()}>
          <p className="text-[17px] font-semibold">Копии в Google Drive</p>
          <p className="mt-1 text-[14px] text-mist">Выберите копию для просмотра. Восстановление потребует подтверждения.</p>
          {!files.length && <p className="py-5 text-[14px] text-mist">Доступных копий Financy пока нет.</p>}
          {files.map((file) => <button key={`${file.id}:${file.revisionId ?? 'current'}`} disabled={loading} onClick={() => { void selectBackup(file) }} className="press mt-3 w-full rounded-2xl bg-white/10 p-3.5 text-left disabled:opacity-40">
            <p className="text-[15px] font-medium">{file.modifiedTime ? dateTime(file.modifiedTime) : 'Резервная копия'}</p>
            <p className="mt-1 break-all text-[12px] text-mist">{file.name}</p>
          </button>)}
          {drive.error && <p className="mt-3 text-[13px] text-amber">{drive.error}</p>}
          <button disabled={loading} onClick={closeBackups} className="press mt-3 h-12 w-full rounded-2xl font-medium text-mist">Отмена</button>
        </div>
      </div>}
    </section>
  )
}
