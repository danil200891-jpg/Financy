// Synthetic browser-only regressions. The runner uses a fresh origin and profile.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { actions, getState, initStore, waitForWrites } from '../src/lib/store'
import * as DB from '../src/lib/db'
import * as backup from '../src/lib/backup'
import { textToCents, toDraft, emptyForm } from '../src/components/OperationForm'
import { fmt, monthName } from '../src/lib/format'
import { byPeriod, dailyCumulative, monthly, totals } from '../src/lib/stats'
import { parseText } from '../src/lib/parse'
import { parseRecognized } from '../src/lib/receipt'
import { preprocess, recognize } from '../src/lib/ocr'
import { toast, dismissToast } from '../src/lib/toast'
import type { Operation, OpType } from '../src/lib/types'
import { smoothSegments, smoothPath } from '../src/lib/sparkline'
import { incomeSources } from '../src/lib/income-sources'
import { watchUpdates, checkForUpdate } from '../src/lib/updates'
import { financials, savePlan, savePlanWithReserve } from '../src/lib/planning'

const wait = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms))
function check(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }
async function until(test: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 300; i++) { if (await test()) return; await wait() }
  throw new Error('Timed out waiting for application state')
}
function button(text: string, root: ParentNode = document.querySelector('[role="dialog"]') ?? document) {
  const result = [...root.querySelectorAll('button')].filter((node) => !node.closest('[aria-hidden="true"]')).find((node) => node.textContent?.trim() === text || node.getAttribute('aria-label') === text || node.querySelector('p')?.textContent?.trim() === text || node.querySelector('span')?.textContent?.trim() === text)
  check(result && !result.disabled, `Missing enabled button ${text}`)
  return result
}
async function click(text: string, root?: ParentNode) { button(text, root).click(); await wait() }
async function input(selector: string, value: string) {
  const element = document.querySelector<HTMLInputElement>(selector)
  check(element, `Missing input ${selector}`)
  Object.getOwnPropertyDescriptor(element.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(element, value)
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
  // Upgrade a genuine v1 database in this fresh profile, including an existing sync setting.
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('finance', 1)
    request.onupgradeneeded = () => {
      const d = request.result
      d.createObjectStore('operations', { keyPath: 'id' }).createIndex('date', 'date')
      d.createObjectStore('clients', { keyPath: 'id' }); d.createObjectStore('categories', { keyPath: 'id' })
      const h = d.createObjectStore('history', { keyPath: 'id' }); h.createIndex('entityId', 'entityId'); h.createIndex('at', 'at')
      d.createObjectStore('meta')
    }
    request.onsuccess = () => { const d = request.result; const tx = d.transaction('meta', 'readwrite'); tx.objectStore('meta').put('synthetic-preserved-setting', 'migration-proof'); tx.oncomplete = () => { d.close(); resolve() } }
    request.onerror = () => reject(request.error)
  })
  await initStore()
  check((await DB.db()).version === 2 && await DB.getMeta('migration-proof') === 'synthetic-preserved-setting', 'v1 upgrade lost settings')
  for (const series of [[0, 0, 0, 100], [10, 5, 20, 20, -30], [1, 1], [0, 50, 0, 50]]) {
    const points = series.map((value, index) => [index * 10, value] as [number, number])
    check(smoothPath(points).includes(' C'), 'Sparkline has no smooth curve')
    for (const { start, c1, c2, end } of smoothSegments(points)) {
      let previous = start[1]
      for (let i = 1; i <= 100; i++) {
        const t = i / 100, u = 1 - t
        const y = u ** 3 * start[1] + 3 * u ** 2 * t * c1[1] + 3 * u * t ** 2 * c2[1] + t ** 3 * end[1]
        check(y >= Math.min(start[1], end[1]) - 1e-8 && y <= Math.max(start[1], end[1]) + 1e-8, 'Curve invented a financial peak')
        check((end[1] >= start[1] ? y >= previous - 1e-8 : y <= previous + 1e-8), 'Curve reversed financial direction')
        previous = y
      }
    }
  }
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
  await savePlan({ kind: 'balance', amount: 100000, at: new Date().toISOString() })
  const beforeAtomic = JSON.stringify(await DB.backupSnapshot())
  const planningPut = IDBObjectStore.prototype.put
  IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
    if (this.name === 'planning' && args[0]?.kind === 'movement') { IDBObjectStore.prototype.put = planningPut; throw new DOMException('Synthetic plan quota', 'QuotaExceededError') }
    return planningPut.apply(this, args)
  }
  let atomicFailed = false
  try { await savePlanWithReserve({ kind: 'envelope', name: 'Synthetic atomic', mode: 'goal', frequency: 'once', target: 50000, priority: 1, state: 'active' }, 25000) } catch { atomicFailed = true }
  IDBObjectStore.prototype.put = planningPut
  check(atomicFailed && JSON.stringify(await DB.backupSnapshot()) === beforeAtomic, 'Plan/reserve failure persisted a partial transaction')
  await actions.wipeAll()
  console.log('PASS bounded smooth financial curve and atomic plan-plus-reserve rollback')
  createRoot(document.getElementById('root')!).render(createElement(App))
  await until(() => !!document.querySelector('main'))
  check(document.querySelectorAll('nav button').length === 5 && !document.querySelector('button[aria-label="Добавить операцию"]'), 'Bottom navigation still has central add button')
  await click('Расход')
  check(!document.querySelector('[role="dialog"] input') && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName ?? ''), 'Expense chooser opens a keyboard or form')
  await click('Вручную')
  await input('input[aria-label="Название"]', 'Synthetic UI')
  await input('input[aria-label="Сумма"]', '12,34')
  await click('Продукты')
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

  const sourceRecord = (id: string, title: string, type: OpType = 'income'): Operation => ({ ...draft(title, 100, type), id, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
  const sampleSources = [sourceRecord('a', '  Real  Company '), sourceRecord('b', 'REAL company'), sourceRecord('c', 'One use'), sourceRecord('d', 'Expense only', 'expense'), sourceRecord('e', 'Expense only', 'expense'), { ...sourceRecord('f', 'One use'), deletedAt: new Date().toISOString() }]
  const suggestions = incomeSources([...sampleSources, sampleSources[0]])
  check(suggestions.length === 1 && suggestions[0].count === 2, 'Source threshold, normalization or duplicate ID handling failed')
  check(incomeSources(sampleSources, ' company ').length === 1 && !incomeSources(sampleSources, 'missing').length, 'Source filtering failed')
  const beforeIncome = getState().operations.length
  for (let index = 0; index < 2; index++) {
    await click('Доход')
    check(document.querySelector<HTMLInputElement>('input[aria-label="Название"]')?.value === '', 'Income source was prefilled')
    check(!document.querySelector('[aria-label="Подсказки источников дохода"]'), 'Source suggested before two saved incomes')
    await input('input[aria-label="Сумма"]', String(20 + index))
    await input('input[aria-label="Название"]', index ? ' synthetic   SOURCE ' : 'Synthetic Source')
    const saveIncome = button('Сохранить доход'); saveIncome.click(); saveIncome.click()
    await until(() => !document.querySelector('[role="dialog"]'))
  }
  check(getState().operations.length === beforeIncome + 2 && getState().operations.filter((operation) => operation.type === 'income').length === 2, 'Income flow duplicated or changed operation type')
  await actions.reload()
  await click('Доход')
  check(document.querySelector<HTMLInputElement>('input[aria-label="Название"]')?.value === '', 'Suggestion automatically inserted')
  check(document.querySelectorAll('[aria-label="Подсказки источников дохода"] button').length === 1, 'Saved normalized source missing or duplicated')
  await input('input[aria-label="Название"]', 'No match')
  check(!document.querySelector('[aria-label="Подсказки источников дохода"]'), 'Nonmatching suggestions remained visible')
  await input('input[aria-label="Название"]', 'source')
  ;(document.querySelector('[aria-label="Подсказки источников дохода"] button') as HTMLButtonElement).click(); await wait()
  check(document.querySelector<HTMLInputElement>('input[aria-label="Название"]')!.value.toLowerCase() === 'synthetic source', 'Explicit suggestion selection failed')
  await click('Назад')
  check(getState().operations.length === beforeIncome + 2, 'Cancelling income form saved data')
  await click('Расход'); await click('Вручную'); await click('Назад')
  check(button('Камера') && button('Из фото') && button('Вручную'), 'Expense back navigation failed')
  await click('Назад')
  console.log('PASS income/expense entry, five-tab navigation, keyboard-free chooser, saved-source threshold/filter/selection, back and double-tap protection')

  // Income form: switch, three categories, searchable client picker, optional client/note.
  const visibleIncomeCats = getState().categories.filter((c) => c.type === 'income' && !c.archived).map((c) => c.name)
  check(JSON.stringify(visibleIncomeCats) === JSON.stringify(['Работа', 'Прочие доходы', 'Разовый клиент']), `Income categories are ${visibleIncomeCats.join(', ')}`)
  check(getState().categories.some((c) => c.id === 'c-photo' && c.archived && !c.deletedAt), 'Old «Съёмки» category was removed instead of hidden')
  await click('Доход')
  check(!document.querySelector('input[placeholder="Заметка"]') && !document.querySelector('[role="dialog"]')!.textContent!.includes('Съёмки'), 'Creation still contains obsolete switch or note')
  const catLabels = [...document.querySelectorAll('[role="dialog"] .grid-cols-3 button span')].map((node) => node.textContent)
  check(JSON.stringify(catLabels) === JSON.stringify(['Работа', 'Прочие доходы', 'Разовый клиент']), `Income category grid shows ${catLabels.join(', ')}`)
  await click('Прочие доходы')
  await input('input[aria-label="Сумма"]', '75')
  await input('input[aria-label="Название"]', 'Synthetic shoot')
  await click('Выбрать клиента')
  await input('input[aria-label="Поиск клиента"]', '  synthetic   ui CLIENT ')
  check(document.querySelectorAll('[role="dialog"]').length === 2, 'Client picker did not open')
  await click('Добавить клиента')
  const clientsAfterDedupe = getState().clients.filter((c) => c.name.toLowerCase().includes('synthetic ui client')).length
  check(clientsAfterDedupe === 1, 'Client picker created a case/space duplicate')
  check(document.querySelector('[aria-label="Выбрать клиента"]')?.textContent?.includes('Synthetic UI client'), 'Existing client was not selected')
  await click('Выбрать клиента')
  await input('input[aria-label="Поиск клиента"]', 'Synthetic new client')
  await click('Добавить клиента'); await waitForWrites()
  const created = getState().clients.find((c) => c.name === 'Synthetic new client')
  check(created && document.querySelector('[aria-label="Выбрать клиента"]')?.textContent?.includes('Synthetic new client'), 'New client was not created and selected')
  await click('Сохранить доход'); await until(() => !document.querySelector('[role="dialog"]'))
  const shoot = getState().operations.find((o) => o.title === 'Synthetic new client')
  check(shoot && shoot.categoryId === 'c-other-in' && shoot.clientId === created!.id && shoot.amount === 7500 && !shoot.note, 'Income with switch/client saved incorrectly')
  await click('Доход')
  await input('input[aria-label="Сумма"]', '5')
  await input('input[aria-label="Название"]', 'Synthetic no client')
  await click('Сохранить доход'); await until(() => !document.querySelector('[role="dialog"]'))
  const noClient = getState().operations.find((o) => o.title === 'Synthetic no client')
  check(noClient && noClient.clientId === null && noClient.incomeKind === 'work', 'Income without client/note did not save')
  // older operation in the hidden category still displays its category name
  const legacy = actions.addOperation({ ...draft('Synthetic legacy shoot', 900, 'income'), categoryId: 'c-photo' }); await waitForWrites()
  await click('История', document.querySelector('nav')!)
  check([...document.querySelectorAll('button')].some((node) => node.textContent?.includes('Synthetic legacy shoot') && node.textContent.includes('Съёмки')), 'Historic hidden category not shown')
  ;[...document.querySelectorAll('button')].find((node) => node.textContent?.includes('Synthetic legacy shoot'))!.click(); await wait()
  check(document.querySelector('[role="dialog"] .bg-white\\/12')?.textContent?.includes('Съёмки') || button('Съёмки'), 'Legacy income kind not derived')
  await closeSheet()
  check(getState().operations.find((o) => o.id === legacy.id)?.categoryId === 'c-photo', 'Opening a legacy operation changed it')
  await click('Главная', document.querySelector('nav')!)
  // migration from the previous category set on an existing device
  {
    const d = await DB.db()
    const old = (id: string, name: string, extra = {}) => ({ id, name, type: 'income' as const, icon: 'tag', color: '#7c8cff', updatedAt: '2025-01-01T00:00:00.000Z', deletedAt: null, ...extra })
    await d.put('categories', old('c-photo', 'Съёмки'))
    await d.put('categories', old('c-other-in', 'Прочий доход'))
    await d.put('categories', old('c-custom-in', 'Синтетический доход'))
    await d.delete('categories', 'c-oneoff')
    await d.delete('meta', 'incomeCategoriesV2')
    const legacyOp = actions.addOperation({ ...draft('Synthetic legacy custom', 300, 'income'), categoryId: 'c-custom-in' }); await waitForWrites()
    await initStore()
    const names = getState().categories.filter((c) => c.type === 'income' && !c.archived).map((c) => c.name)
    check(JSON.stringify(names) === JSON.stringify(['Работа', 'Прочие доходы', 'Разовый клиент']), `Migration left ${names.join(', ')}`)
    check(getState().categories.find((c) => c.id === 'c-custom-in')?.archived === true, 'Custom income category not hidden')
    check(getState().operations.find((o) => o.id === legacyOp.id)?.categoryId === 'c-custom-in', 'Migration changed an operation')
    check(getState().categories.every((c) => !c.deletedAt || c.id.startsWith('Synthetic')), 'Migration deleted a category')
    await initStore()
    check(getState().categories.filter((c) => c.id === 'c-oneoff').length === 1, 'Migration not idempotent')
  }
  console.log('PASS simplified income, exactly three income categories, hidden legacy category, client search/add/dedupe/select, optional client and note')

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
  await click('Расход'); await click('Из фото')
  check(filePickerClicks === 1, 'Gallery not opened synchronously from user action')
  fileInput.click = originalClick
  await closeSheet()
  await click('Расход'); await click('Камера')
  await until(() => (document.querySelector('video')?.videoWidth ?? 0) > 0)
  const track = (document.querySelector('video')!.srcObject as MediaStream).getVideoTracks()[0]
  await click('Закрыть камеру'); check(track.readyState === 'ended', 'Camera track leaked after close')
  await closeSheet()
  await click('Расход'); await click('Из фото')
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

  await click('Планирование', document.querySelector('nav')!)
  const operationCount = getState().operations.length
  await click('Указать фактический остаток')
  await input('input[aria-label="Фактический баланс"]', '1000')
  await click('Сохранить'); await until(() => !document.querySelector('[role="dialog"]'))
  check(financials(getState().operations, getState().planning).balance === 100000 && getState().operations.length === operationCount, 'Balance checkpoint manufactured an operation')
  await click('Настройки планирования'); await click('Настроить баланс'); await input('input[aria-label="Фактический баланс"]', '950')
  await click('Сохранить'); await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().planning.filter((r) => r.kind === 'balance').length === 2, 'Manual correction overwrote balance history')
  check(!document.querySelector('main input[type="checkbox"]') && !document.querySelector('main')!.textContent!.includes('Хватит ли денег'), 'Planning main remains overloaded')
  await click('Добавить план'); await input('input[aria-label="Название плана"]', 'Synthetic rent')
  await input('input[aria-label="Нужный бюджет"]', '750'); await input('input[aria-label="Зарезервировать сейчас"]', '9999')
  check([...document.querySelectorAll('button')].some((b) => b.textContent === 'Создать план' && b.disabled), 'Unaffordable reserve enabled creation')
  await input('input[aria-label="Зарезервировать сейчас"]', '750')
  const reserveButton = button('Создать план'); reserveButton.click(); reserveButton.click()
  await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().planning.filter((r) => r.kind === 'movement').length === 1 && financials(getState().operations, getState().planning).reserved === 0, 'Offline reserve was duplicated or confirmed without PC')
  const planned = await backup.buildBackup()
  check(backup.parseBackup(JSON.stringify(planned)).planning?.length === 4, 'Planning backup roundtrip lost records')
  const { planning: _planning, ...legacyBackup } = planned
  await backup.restore(backup.parseBackup(JSON.stringify({ ...legacyBackup, version: 1 })), 'replace')
  check(getState().planning.length === 4, 'Legacy replacement cleared planning')
  await actions.reload()
  check(getState().planning.length === 4 && getState().operations.length === operationCount, 'Planning reload lost financial data')
  // A confirmed reserve restored on a new device must be rechecked, not blindly authorized.
  const movement = planned.planning!.find((r) => r.kind === 'movement')!
  await backup.restore({ ...planned, planning: [{ ...movement, id: 'synthetic-imported-reserve', status: 'confirmed', updatedAt: new Date().toISOString() }] }, 'merge')
  check(getState().planning.find((r) => r.id === 'synthetic-imported-reserve')?.status === 'pending', 'Imported reserve bypassed server validation')
  await savePlan({ kind: 'settings', id: 'planning-settings', auto: true })
  console.log('PASS v1→v2 non-destructive upgrade, manual balance history, planning UI, provisional reserve double-tap guard, reload, v1/v2 backup compatibility')

  await click('Главная', document.querySelector('nav')!)
  await click('Доход'); await input('input[aria-label="Сумма"]', '5,50')
  check(!document.querySelector('input[placeholder="Заметка"]'), 'New income still has note input')
  await click('Сохранить доход'); await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().operations.some((o) => o.type === 'income' && o.amount === 550 && o.title === '' && o.categoryId === 'c-work'), 'Optional income source or default category failed')
  await click('Расход'); await click('Вручную'); await input('input[aria-label="Название"]', 'Lidl')
  check(button('Продукты').getAttribute('aria-pressed') === 'true', 'Known merchant category not suggested')
  await click('Кафе'); await input('input[aria-label="Название"]', 'Mercadona')
  check(button('Кафе').getAttribute('aria-pressed') === 'true', 'Automatic category overrode a manual choice')
  await input('input[aria-label="Название"]', ''); await input('input[aria-label="Сумма"]', '25')
  await click('Сохранить расход'); await until(() => !document.querySelector('[role="dialog"]'))
  check(getState().operations.some((o) => o.type === 'expense' && o.amount === 2500 && o.title === 'Кафе'), 'Optional recipient did not fall back to category name')
  console.log('PASS anonymous income, default category, optional recipient, local category hints and manual override priority')
  const recurring = getState().planning.find((r) => r.kind === 'envelope')!
  actions.addOperation({ ...draft('Synthetic paid period', recurring.target!), planningPayment: { envelopeId: recurring.id, reserved: 0, period: recurring.due } }); await waitForWrites()
  await savePlan({ ...recurring, target: recurring.target! + 5000 })
  const revised = getState().planning.find((r) => r.id === recurring.id)!
  check(revised.due! > recurring.due! && revised.terms?.[0]?.target === recurring.target, 'Changing recurring amount reopened an already paid period')
  console.log('PASS recurring amount changes preserve already-paid period terms')

  await savePlan({ kind: 'balance', amount: 500000, at: new Date().toISOString() })
  await click('Планирование', document.querySelector('nav')!)
  const beforeSimple = getState().operations.length
  await click('Добавить план')
  await input('input[aria-label="Название плана"]', 'Synthetic simple plan')
  await input('input[aria-label="Нужный бюджет"]', '800')
  await input('input[aria-label="Зарезервировать сейчас"]', '500')
  check(document.querySelector('[role="dialog"]')!.textContent!.includes('Останется свободно'), 'Missing live budget preview')
  await click('Создать план'); await until(() => !document.querySelector('[role="dialog"]'))
  const simple = getState().planning.find((r) => r.name === 'Synthetic simple plan')!
  const firstReserve = getState().planning.find((r) => r.kind === 'movement' && r.to === simple.id)!
  actions.savePlanning({ ...firstReserve, status: 'confirmed' }); await waitForWrites()
  await click('Открыть план Synthetic simple plan')
  check(!document.querySelector('[role="dialog"]') && document.activeElement?.tagName !== 'INPUT', 'Plan tap opened a modal or keyboard')
  await input('input[aria-label="Сумма резерва Synthetic simple plan"]', '999999')
  check([...document.querySelectorAll<HTMLButtonElement>('.plan-expansion.is-open button')].find((b) => b.textContent === 'Подтвердить резерв')?.disabled, 'Inline reserve exceeded free funds')
  await input('input[aria-label="Сумма резерва Synthetic simple plan"]', '100')
  check(document.querySelector('main')!.textContent!.includes('После пополнения'), 'Inline reserve preview missing')
  const inlineSubmit = button('Подтвердить резерв'); inlineSubmit.click(); inlineSubmit.click()
  await until(() => button('Открыть план Synthetic simple plan').getAttribute('aria-expanded') === 'false')
  const increase = getState().planning.find((r) => r.kind === 'movement' && r.to === simple.id && r.id !== firstReserve.id)!
  check(increase.amount === 10000, 'Reserve edit created full amount instead of delta')
  actions.savePlanning({ ...increase, status: 'confirmed' }); await waitForWrites()
  const freeBeforeDecrease = financials(getState().operations, getState().planning).free
  await click('Открыть план Synthetic simple plan')
  await click('Уменьшить или перевести резерв')
  await input('select[aria-label="Действие с резервом"]', 'set')
  await input('input[aria-label="Сумма движения"]', '450')
  await click('Сохранить'); await until(() => !document.querySelector('[role="dialog"]'))
  await click('Настройки плана Synthetic simple plan')
  check(!document.querySelector('input[aria-label="Зарезервировать сейчас"]'), 'Metadata edit still mixes reserve input')
  const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1)
  await input('input[aria-label="Дата платежа"]', toDraft({ ...emptyForm(), amountText: '1', title: 'Synthetic', date: [tomorrow.getFullYear(), String(tomorrow.getMonth() + 1).padStart(2, '0'), String(tomorrow.getDate()).padStart(2, '0')].join('-') }, 'manual')!.date.slice(0, 10))
  await input('input[aria-label="Нужный бюджет"]', '900')
  await click('Сохранить изменения'); await until(() => !document.querySelector('[role="dialog"]'))
  const decrease = getState().planning.find((r) => r.kind === 'movement' && r.from === simple.id)!
  check(decrease.amount === 15000 && financials(getState().operations, getState().planning).free === freeBeforeDecrease, 'Pending release was spent before confirmation')
  actions.savePlanning({ ...decrease, status: 'confirmed' }); await waitForWrites()
  check(financials(getState().operations, getState().planning).reserves[simple.id] === 45000 && financials(getState().operations, getState().planning).free === freeBeforeDecrease! + 15000, 'Reserve reduction did not release exactly the delta')
  check(getState().planning.find((r) => r.id === simple.id)?.target === 90000, 'Budget edit was lost')
  await click('Настройки плана Synthetic simple plan')
  const confirm = window.confirm; window.confirm = () => true
  await click('Удалить план'); await until(() => !document.querySelector('[role="dialog"]'))
  window.confirm = confirm
  check(getState().planning.find((r) => r.id === simple.id)?.state === 'closed' && getState().operations.length === beforeSimple, 'Closing plan deleted financial data')
  const release = getState().planning.find((r) => r.kind === 'movement' && r.from === simple.id && r.status === 'pending')!
  check(release.amount === 45000, 'Deleting plan did not request exact remaining reserve release')
  actions.savePlanning({ ...release, status: 'confirmed' }); await waitForWrites()
  check(financials(getState().operations, getState().planning).reserves[simple.id] === 0 && !document.querySelector('main')!.textContent!.includes('Synthetic simple plan'), 'Closed empty plan did not move to archive')
  console.log('PASS inline plan expansion without keyboard/modal, preview, insufficient funds, duplicate-tap guard, automatic collapse, reserve reduction, independent metadata edit and safe archive')

  await click('Главная', document.querySelector('nav')!)
  const displayed = (label: string) => document.querySelector(`[aria-label="${label}"]`)!.textContent!.replace(/\s/g, '').replace('−', '-')
  const formatted = (cents: number) => fmt(cents).replace(/\s/g, '')
  const checkHome = (period = new Date()) => {
    const money = financials(getState().operations, getState().planning)
    const monthlyNet = totals(byPeriod(getState().operations, 'month', period)).net
    check(displayed('Свободные деньги') === formatted(money.free!), 'Hero does not show current confirmed free money')
    check(displayed('Подтверждённый резерв') === formatted(money.reserved), 'Home reserve includes unconfirmed requests')
    check(displayed('Итог месяца') === formatted(monthlyNet), 'Month result subtracts reserve or uses the wrong month')
    check(document.querySelector('main')!.textContent!.includes('Итог за ' + monthName(period)), 'Selected month label incorrect')
  }
  checkHome()
  const beforeHomeReserve = financials(getState().operations, getState().planning).free!
  const homeReserve = await savePlan({ kind: 'movement', amount: 10000, from: null, to: recurring.id, status: 'pending' })
  checkHome(); check(financials(getState().operations, getState().planning).free === beforeHomeReserve, 'Pending reserve reduced free cash')
  actions.savePlanning({ ...homeReserve, status: 'confirmed' }); await waitForWrites(); await wait()
  checkHome(); check(financials(getState().operations, getState().planning).free === beforeHomeReserve - 10000, 'Confirmed reserve not deducted exactly once')
  const homeRelease = await savePlan({ kind: 'movement', amount: 4000, from: recurring.id, to: null, status: 'pending' })
  checkHome(); check(financials(getState().operations, getState().planning).free === beforeHomeReserve - 10000, 'Pending release increased free cash')
  actions.savePlanning({ ...homeRelease, status: 'confirmed' }); await waitForWrites(); await wait()
  checkHome(); check(financials(getState().operations, getState().planning).free === beforeHomeReserve - 6000, 'Reserve reduction did not release correct cash')
  actions.addOperation(draft('Synthetic home income', 5000, 'income'))
  actions.addOperation(draft('Synthetic home expense', 1200))
  const previousMonth = new Date(new Date().getFullYear(), new Date().getMonth() - 1, 15, 12)
  actions.addOperation({ ...draft('Synthetic previous month income', 8765, 'income'), date: previousMonth.toISOString() })
  await waitForWrites(); await wait(); checkHome()
  const currentFree = displayed('Свободные деньги')
  await click('Предыдущий месяц'); checkHome(previousMonth)
  check(displayed('Свободные деньги') === currentFree, 'Month selection changed current available cash')
  await click('Следующий месяц'); checkHome()
  await click('Настроить баланс'); await click('Настройки планирования'); await click('Настроить баланс')
  check(!!document.querySelector('input[aria-label="Фактический баланс"]'), 'Initial balance settings inaccessible from Home')
  await click('Отмена'); await click('Главная', document.querySelector('nav')!)
  console.log('PASS Home current free cash, confirmed/pending reserve and release, monthly net without double deduction, month switching and balance settings')

  let updateChecks = 0
  watchUpdates({ update: async () => { updateChecks++ } } as unknown as ServiceWorkerRegistration)
  await wait(); check(updateChecks === 1, 'Startup did not check for an update')
  const realNow = Date.now
  try {
    Date.now = () => realNow() + 16000
    document.dispatchEvent(new Event('visibilitychange')); await wait()
    check(Number(updateChecks) === 2, 'Foreground did not check for an update')
    window.dispatchEvent(new Event('pageshow')); await wait()
    check(Number(updateChecks) === 2, 'Foreground events caused duplicate update checks')
    window.dispatchEvent(new Event('online')); await wait()
    check(Number(updateChecks) === 3, 'Reconnect did not check for an update')
    await checkForUpdate(true)
    check(Number(updateChecks) === 4, 'Manual update check did not run')
  } finally { Date.now = realNow }
  console.log('PASS PWA update checks at startup, foreground, online and manual request; duplicate foreground events throttled')

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
