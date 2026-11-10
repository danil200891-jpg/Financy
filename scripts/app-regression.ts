// Synthetic browser-only regressions. The runner uses a fresh origin and profile.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { actions, getState, initStore, waitForWrites } from '../src/lib/store'
import * as DB from '../src/lib/db'
import * as backup from '../src/lib/backup'
import { textToCents, toDraft, emptyForm } from '../src/components/OperationForm'
import { byPeriod, dailyCumulative, monthly, totals } from '../src/lib/stats'
import { parseText } from '../src/lib/parse'
import { parseRecognized } from '../src/lib/receipt'
import { preprocess, recognize } from '../src/lib/ocr'
import { toast, dismissToast } from '../src/lib/toast'
import type { Operation, OpType } from '../src/lib/types'

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(test: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await test()) return; await wait() }
  throw new Error('Timed out waiting for application state')
}
function button(text: string, root: ParentNode = document.querySelector('[role="dialog"]') ?? document) {
  const result = [...root.querySelectorAll('button')].find((node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text || node.querySelector('p')?.textContent?.trim() === text || node.querySelector('span')?.textContent?.trim() === text)
  check(result && !result.disabled, `Missing enabled button ${text}`)
  return result
}
async function click(text: string, root?: ParentNode) { button(text, root).click(); await wait() }
async function input(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(selector)
  check(element, `Missing input ${selector}`)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  await wait()
}
const draft = (title: string, amount: number, type: OpType = 'expense', currency = 'EUR') => ({
  title, amount, type, currency, date: new Date().toISOString(), categoryId: null, clientId: null, source: 'manual' as const,
})
async function closeSheet() {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  await until(() => !document.querySelector('[role="dialog"]'))
}

export async function runAppRegression() {
  const failures: string[] = []
  window.addEventListener('unhandledrejection', (event) => failures.push(String(event.reason)))
  await initStore()
  for (const [text, cents] of [['1 234,56', 123456], ['0,01', 1], ['12.50', 1250], ['0', null], ['1.2.3', null], ['12abc', null], ['1,234', null], ['999999999999999999', null]] as const) {
    check(textToCents(text) === cents, `Incorrect amount ${text}`)
  }
  check(toDraft({ ...emptyForm(), title: 'Synthetic', amountText: '1', date: '' }, 'manual') === null, 'Empty date did not fail safely')
  check(toDraft({ ...emptyForm(), title: 'Synthetic', amountText: '1', date: '2026-02-31' }, 'manual') === null, 'Invalid date normalized silently')
  const originalDate = new Date(2026, 10, 10, 14, 22, 33, 456).toISOString()
  const edited = toDraft({ ...emptyForm(), title: 'Synthetic', amountText: '1', date: '2026-11-10', currency: 'USD' }, 'import', originalDate)
  check(edited?.date === originalDate && edited.currency === 'USD', 'Editing changed the timestamp or currency')
  check(parseText('Neuro +1.234,56 €', []).title === 'Neuro' && parseText('Neuro +1.234,56 €', []).amount === 123456, 'Manual merchant or thousand separators parsed incorrectly')
  check(parseText('Test 12.34.56', []).amount === null, 'Malformed number guessed as amount')
  check(parseRecognized('10.11.2026', 'receipt', [], [], new Date(2026, 10, 10)).amount === null, 'Date invented a receipt amount')
  check(parseRecognized('MERCADONA\nTOTAL 42', 'receipt', [], []).amount === 4200, 'Integer receipt total missed')
  console.log('PASS strict cents, date safety, timestamp/currency preservation, manual parser and receipt totals/date exclusion')

  const client = actions.addClient('Synthetic client', '#7c8cff')
  const income = actions.addOperation({ ...draft('Synthetic income', 10000, 'income'), clientId: client.id })
  const expense = actions.addOperation(draft('Synthetic expense', 2500))
  await waitForWrites()
  check(totals(getState().operations).net === 7500, 'Incorrect income/expense balance')
  actions.addOperation(draft('Synthetic USD', 99900, 'income', 'USD')); await waitForWrites()
  check(totals(getState().operations).net === 7500, 'Different currencies mixed into EUR totals')
  const fixed = new Date(2026, 10, 10, 12)
  const future = { ...income, date: new Date(2026, 10, 20).toISOString() }
  check(dailyCumulative([future], fixed).length === 10, 'Future transaction extended today sparkline')
  check(byPeriod([future], 'month', fixed).length === 1 && monthly([future], 2, fixed)[1].income === 10000, 'Monthly/year boundaries incorrect')
  const initial = JSON.stringify(await DB.backupSnapshot())
  const originalPut = IDBObjectStore.prototype.put
  let failNext = true
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'operations' && failNext) { failNext = false; throw new DOMException('Synthetic quota', 'QuotaExceededError') }
    return originalPut.apply(this, args)
  }
  actions.removeClient(client.id)
  let rejected = false
  try { await waitForWrites() } catch { rejected = true }
  IDBObjectStore.prototype.put = originalPut
  check(rejected && JSON.stringify(await DB.backupSnapshot()) === initial, 'Failed client removal changed persisted records')
  check(getState().clients.some((item) => item.id === client.id) && getState().operations.find((item) => item.id === income.id)?.clientId === client.id, 'Failed transaction did not roll back UI')
  actions.removeClient(client.id); await waitForWrites()
  check(getState().operations.find((item) => item.id === income.id)?.clientId === null, 'Client removal did not preserve operation as one-off')
  actions.removeOperation(expense.id); await waitForWrites()
  check(getState().deleted.some((item) => item.id === expense.id), 'Soft deletion failed')
  actions.restoreOperation(expense.id); await waitForWrites()
  check(getState().operations.some((item) => item.id === expense.id), 'Undo deletion failed')
  console.log('PASS durable writes, totals, atomic client removal, failed-write UI rollback, soft delete and restore')

  const saved = await backup.buildBackup()
  const parsed = backup.parseBackup(JSON.stringify(saved))
  check(parsed.operations.length === saved.operations.length, 'JSON roundtrip lost records')
  for (const invalid of [{ ...saved, clients: [{}] }, { ...saved, history: [{}] }, { ...saved, operations: [saved.operations[0], saved.operations[0]] }, { ...saved, categories: {} }]) {
    let failed = false; try { backup.parseBackup(JSON.stringify(invalid)) } catch { failed = true }
    check(failed, 'Damaged backup silently accepted')
  }
  await backup.restore(parsed, 'merge'); await backup.restore(parsed, 'merge')
  check((await backup.buildBackup()).operations.length === saved.operations.length, 'Repeated merge duplicated records')
  const changed = { ...saved, operations: [{ ...saved.operations[0], id: 'synthetic-replacement' }] }
  await backup.restore(changed, 'replace')
  check(getState().all.operations.length === 1, 'Confirmed replacement failed')
  await backup.undoRestore()
  check(JSON.stringify((await backup.buildBackup()).operations) === JSON.stringify(saved.operations), 'Undo replacement did not restore exact records')
  actions.addOperation({ ...draft('=SYNTHETIC()', 150), note: '+SYNTHETIC()' }); await waitForWrites()
  check(backup.buildCSV().includes("'=SYNTHETIC()") && backup.buildCSV().includes("'+SYNTHETIC()"), 'CSV formula strings not escaped')
  console.log('PASS JSON compatibility, damaged-file rejection, idempotent merge, replacement/undo, CSV safety')

  await actions.wipeAll() // Only this isolated test database is reset.
  createRoot(document.getElementById('root')!).render(createElement(App))
  await until(() => !!document.querySelector('main'))
  await click('Текстом')
  await input('input[placeholder="Mercadona -42 €"]', 'Synthetic UI -12,34 €')
  const saveButton = button('Сохранить расход')
  saveButton.click(); saveButton.click()
  await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().operations.length === 1, 'Double tap created duplicate operations')
  await click('История', document.querySelector('nav')!)
  const row = [...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Synthetic UI'))!
  row.click(); await wait()
  await input('input[aria-label="Название"]', 'Synthetic UI edited')
  await input('input[aria-label="Сумма"]', '15,67')
  await click('Сохранить изменения')
  await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().operations[0].amount === 1567 && getState().operations[0].title === 'Synthetic UI edited', 'UI edit failed')
  ;[...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Synthetic UI edited'))!.click(); await wait()
  await click('Удалить операцию'); await click('Отмена')
  check(getState().operations.length === 1, 'Deletion cancellation changed data')
  await click('Удалить операцию'); await click('Удалить')
  await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().deleted.length === 1, 'UI soft deletion failed')
  await click('Главная', document.querySelector('nav')!); await click('Настройки')
  await click('Недавно удалённые'); await click('Вернуть'); await waitForWrites(); await closeSheet()
  await click('Назад')
  await click('Клиенты', document.querySelector('nav')!); await click('Добавить клиента')
  await input('input[placeholder="Название или имя"]', 'Synthetic UI client')
  await click('Сохранить клиента'); await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().clients.length === 1, 'Client form failed')
  await click('Аналитика', document.querySelector('nav')!); await click('Год'); await click('Всё время'); await click('Доходы')
  await click('Главная', document.querySelector('nav')!); await click('Настройки'); await click('Категории')
  await input('input[placeholder="Название"]', 'Synthetic UI category')
  await click('Добавить категорию'); await waitForWrites()
  check(getState().categories.some((category) => category.name === 'Synthetic UI category'), 'Category form failed')
  await closeSheet(); await click('Назад')
  console.log('PASS primary navigation, add/edit/delete/cancel/restore, duplicate-tap guard, client/category forms and analytics filters')

  toast('Synthetic persistent update', { label: 'Synthetic update', run: () => false }, 0)
  toast('Synthetic transient', undefined, 20); await wait(60)
  check(document.body.textContent?.includes('Synthetic persistent update'), 'Update prompt lost behind transient toast')
  await click('Synthetic update')
  check(document.body.textContent?.includes('Synthetic persistent update'), 'Cancelled update prompt dismissed')
  dismissToast()
  const huge = document.createElement('canvas'); huge.width = 10; huge.height = 12000
  const scaled = await preprocess(huge.toDataURL())
  check(scaled.width <= 2200 && scaled.height <= 2200, 'OCR canvas exceeded pixel bound')
  const cancelled = new AbortController(); cancelled.abort()
  let aborted = false; try { await recognize(huge.toDataURL(), undefined, cancelled.signal) } catch { aborted = true }
  check(aborted, 'Cancelled recognition did not settle')
  huge.width = huge.height = scaled.width = scaled.height = 0
  let filePickerClicks = 0
  const fileInput = document.getElementById('receipt-image-input') as HTMLInputElement
  const originalClick = fileInput.click
  fileInput.click = () => { filePickerClicks++ }
  await click('Из фото')
  check(filePickerClicks === 1, 'Gallery not opened synchronously from user action')
  fileInput.click = originalClick
  await closeSheet()
  await click('Камера')
  await until(() => (document.querySelector('video')?.videoWidth ?? 0) > 0)
  const track = (document.querySelector('video')!.srcObject as MediaStream).getVideoTracks()[0]
  await click('Закрыть камеру'); check(track.readyState === 'ended', 'Camera track leaked after close')
  await closeSheet()
  await click('Из фото')
  const receipt = document.createElement('canvas'); receipt.width = 1000; receipt.height = 650
  const context = receipt.getContext('2d')!; context.fillStyle = 'white'; context.fillRect(0, 0, 1000, 650); context.fillStyle = 'black'; context.font = '48px Arial'
  ;['MERCADONA', 'TOTAL 42,00 EUR'].forEach((line, index) => context.fillText(line, 50, 150 + index * 180))
  const receiptBlob = await new Promise<Blob>((resolve) => receipt.toBlob((blob) => resolve(blob!)))
  const transfer = new DataTransfer(); transfer.items.add(new File([receiptBlob], 'synthetic-receipt.png', { type: 'image/png' }))
  fileInput.files = transfer.files; fileInput.dispatchEvent(new Event('change', { bubbles: true }))
  await until(() => document.body.textContent!.includes('Проверьте распознанное'))
  check(textToCents(document.querySelector<HTMLInputElement>('input[aria-label="Сумма"]')!.value) === 4200, 'Actual OCR did not find receipt amount')
  await input('input[aria-label="Сумма"]', '43,21')
  await click('Сохранить расход'); await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().operations.some((item) => item.title === 'Mercadona' && item.amount === 4321), 'Recognition corrections were not saved')
  receipt.width = receipt.height = 0
  console.log('PASS gallery file selection, actual local OCR and editing recognized amount before save')
  console.log('PASS persistent update prompt, bounded photo processing, recognition cancellation, direct gallery picker and camera cleanup')

  const start = performance.now()
  const seed: Operation[] = Array.from({ length: 10000 }, (_, index) => ({
    ...draft(`Synthetic bulk ${index}`, 100 + index), id: `synthetic-bulk-${index}`,
    date: new Date(Date.now() - index * 86400000).toISOString(), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }))
  await DB.commit(seed.map((value) => ({ store: 'operations', value })))
  await actions.reload()
  console.log(`INFO 10000 synthetic records committed/reloaded in ${Math.round(performance.now() - start)} ms`)
  await click('История', document.querySelector('nav')!)
  check([...document.querySelectorAll('button')].filter((node) => node.textContent?.includes('Synthetic bulk')).length < 101, 'History rendered all 10000 rows at once')
  await click('Показать ещё')
  check([...document.querySelectorAll('button')].filter((node) => node.textContent?.includes('Synthetic bulk')).length > 100, 'History pagination failed')
  await input('input[placeholder="Поиск по названию или клиенту"]', 'Synthetic bulk 9999')
  check(document.body.textContent?.includes('Synthetic bulk 9999'), 'Old operation hidden from search')
  check(!failures.length, `Unhandled JavaScript errors: ${failures.join('; ')}`)
  console.log('PASS large-history pagination and access to oldest records, no unhandled JS failures')
  return 'All application stability regressions passed'
}
