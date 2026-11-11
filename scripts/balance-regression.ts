// Balance adjustment regressions in a fresh browser origin. No user database is opened.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import App from '../src/App'
import { actions, getState, initStore, waitForWrites } from '../src/lib/store'
import * as backup from '../src/lib/backup'
import { totals, byPeriod, monthly } from '../src/lib/stats'
import { adjustments, currentBalance, saveAdjustment } from '../src/lib/balance-adjust'

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms))
function check(v: unknown, msg: string): asserts v { if (!v) throw new Error(`FAIL ${msg}`) }
const balance = () => currentBalance(getState().operations, getState().planning)
const op = (type: 'income' | 'expense', amount: number, title: string, date = new Date().toISOString()) =>
  actions.addOperation({ type, amount, currency: 'EUR', title, categoryId: null, clientId: null, date, source: 'manual' })
const statsSnapshot = () => JSON.stringify({ all: totals(getState().operations), month: totals(byPeriod(getState().operations, 'month')), year: totals(byPeriod(getState().operations, 'year')), monthly: monthly(getState().operations, 12) })
const later = () => wait(5)

export async function balancePhase1() {
  const failures: string[] = []
  window.addEventListener('unhandledrejection', (e) => failures.push(String(e.reason)))
  await initStore()
  const out: string[] = []
  const pass = (m: string) => { console.log(`PASS ${m}`); out.push(m) }

  // starting point: some history before any balance is known
  op('income', 100000, 'Old income', new Date(Date.now() - 5 * 864e5).toISOString())
  op('expense', 2500, 'Old expense', new Date(Date.now() - 4 * 864e5).toISOString())
  await waitForWrites()
  check(balance() === null, 'balance known before any correction')
  const ops0 = getState().all.operations.length
  const stats0 = statsSnapshot()

  // 1. first correction = starting balance 1 250 €
  await saveAdjustment(125000, 'Начальный баланс'); await later()
  check(balance() === 125000, `starting balance ${balance()}`)
  let h = adjustments(getState().operations, getState().planning)
  check(h.length === 1 && h[0].before === null && h[0].after === 125000 && h[0].diff === null && h[0].reason === 'Начальный баланс', `first history ${JSON.stringify(h)}`)

  // 2. new income and expense move the corrected balance
  op('income', 30000, 'Новый доход'); op('expense', 5000, 'Новый расход'); await waitForWrites(); await later()
  check(balance() === 125000 + 30000 - 5000, `after new operations ${balance()}`)
  pass('starting balance 1 250 €; new income +300 € and expense −50 € give 1 500 €')

  // 3. negative correction: 1 500 € → 1 460 € (−40 €)
  await saveAdjustment(146000, 'Комиссия банка'); await later()
  check(balance() === 146000, `negative correction ${balance()}`)
  // 4. positive correction: 1 460 € → 1 500,55 € (+40,55 €), no reason
  await saveAdjustment(150055, ''); await later()
  check(balance() === 150055, `positive correction ${balance()}`)
  op('expense', 10055, 'Расход после корректировки'); await waitForWrites(); await later()
  check(balance() === 140000, `expense after corrections ${balance()}`)
  h = adjustments(getState().operations, getState().planning)
  check(h.length === 3, `history length ${h.length}`)
  check(h[0].before === 146000 && h[0].after === 150055 && h[0].diff === 5500 - 1445 && h[0].reason === '', `latest entry ${JSON.stringify(h[0])}`)
  check(h[1].before === 150000 && h[1].after === 146000 && h[1].diff === -4000 && h[1].reason === 'Комиссия банка', `negative entry ${JSON.stringify(h[1])}`)
  check(h.every((x) => typeof x.at === 'string' && Number.isFinite(Date.parse(x.at))), 'history without date/time')
  pass('negative −40 € and positive +40,55 € corrections in a row; history keeps date, before, after, signed difference, reason')

  // 5. corrections are not operations and never reach statistics
  check(getState().all.operations.length === ops0 + 3, 'a correction created an operation')
  const corrIds = new Set(getState().planning.filter((r) => r.kind === 'balance').map((r) => r.id))
  check(!getState().all.operations.some((o) => corrIds.has(o.id)) && corrIds.size === 3, 'correction stored among operations')
  const stats1 = JSON.parse(statsSnapshot())
  const s0 = JSON.parse(stats0)
  check(stats1.all.income === s0.all.income + 30000 && stats1.all.expense === s0.all.expense + 5000 + 10055, 'statistics include corrections')
  pass('corrections create no operations; income, expense, month/year and monthly statistics change only by real operations')

  // 6. a correction never rewrites the past: an older expense entered later does not move the balance
  op('expense', 700, 'Вчерашний расход, внесённый позже', new Date(Date.now() - 864e5).toISOString()); await waitForWrites(); await later()
  check(balance() === 140000, `back-dated operation changed the corrected balance: ${balance()}`)
  pass('an operation dated before the correction (already in the real balance) does not change it; past operations untouched')

  // 7. backup round trip keeps the corrections; a restore cannot apply one twice
  const b = await backup.buildBackup()
  check(b.planning!.filter((r) => r.kind === 'balance').length === 3, 'backup lacks corrections')
  const parsed = backup.parseBackup(JSON.stringify(b))
  await backup.restore(parsed, 'merge'); await later()
  check(getState().planning.filter((r) => r.kind === 'balance').length === 3 && balance() === 140000, 'merge restore duplicated or changed corrections')
  await backup.restore(parsed, 'replace'); await later()
  check(getState().planning.filter((r) => r.kind === 'balance').length === 3 && balance() === 140000, 'replace restore lost or changed corrections')
  pass('backup contains corrections; merge and replace restore keep 3 corrections and the balance 1 400 €')

  // 8. UI: first item in Settings, live difference, saving from the sheet
  createRoot(document.getElementById('root')!).render(createElement(App))
  await wait(300)
  ;[...document.querySelectorAll('button')].find((n) => n.getAttribute('aria-label') === 'Настройки')!.click(); await wait(300)
  const firstRow = [...document.querySelectorAll('.anim-push button')][1]
  const plain = (t?: string | null) => (t ?? '').replace(/[s  ]/g, '')
  check(firstRow?.textContent?.includes('Корректировка фактического баланса') && plain(firstRow.textContent).includes('1400,00€'), `balance Settings item: ${firstRow?.textContent}`)
  const screenText = document.querySelector('.anim-push')?.textContent ?? ''
  check(screenText.indexOf('Данные хранятся на этом устройстве') >= 0 && screenText.indexOf('Данные хранятся на этом устройстве') < screenText.indexOf('Корректировка фактического баланса'), 'storage card must come before the balance adjustment')
  ;(firstRow as HTMLButtonElement).click(); await wait(300)
  const dlg = () => [...document.querySelectorAll('[role="dialog"]')].filter((x) => !x.closest('[inert]')).pop()!
  check(dlg().textContent?.includes('Баланс в приложении') && plain(dlg().textContent).includes('1400,00€'), 'sheet does not show the app balance')
  const input = [...dlg().querySelectorAll('label')].find((l) => l.textContent?.startsWith('Фактический баланс'))!.querySelector('input')!
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '1 360')
  input.dispatchEvent(new Event('input', { bubbles: true })); await wait(50)
  check(dlg().textContent?.replace(/\s/g, '').includes('−40,00€'), `difference not shown: ${dlg().textContent}`)
  ;[...dlg().querySelectorAll('button')].find((x) => x.textContent === 'Сохранить корректировку')!.click()
  await waitForWrites(); await wait(200)
  check(balance() === 136000, `UI save ${balance()}`)
  check(dlg().textContent?.includes('История корректировок') && adjustments(getState().operations, getState().planning).length === 4, 'history not updated in the sheet')
  check(!failures.length, `JS errors: ${failures.join('; ')}`)
  pass('Settings: second item after storage card, app balance, live difference −40 €, save, history updated; no JS errors')
  return `phase 1: ${out.length} checks`
}

/** After a full page reload (app restart). */
export async function balancePhase2() {
  await initStore()
  const h = adjustments(getState().operations, getState().planning)
  check(h.length === 4 && balance() === 136000, `after restart: ${h.length} corrections, balance ${balance()}`)
  op('income', 4000, 'Доход после перезапуска'); await waitForWrites()
  check(balance() === 140000, 'operation after restart')
  return 'phase 2: 4 corrections and balance kept after restart; new income moves it to 1 400 €'
}
