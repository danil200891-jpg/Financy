// Invoice → PDF, entirely on the device (pdf-lib + bundled Onest font; works offline).
// Document language is Spanish. Content follows the fields of art. 6 RD 1619/2012; it does not
// implement VERI*FACTU (hash chain / QR), which applies to autónomos from 1 July 2027.
import { PDFDocument, degrees, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import regularUrl from '@expo-google-fonts/onest/400Regular/Onest_400Regular.ttf?url'
import boldUrl from '@expo-google-fonts/onest/600SemiBold/Onest_600SemiBold.ttf?url'
import type { Invoice, PartySnapshot } from './invoice-types'
import { computeTotals, formatIban, lineAmount, quantityLabel, rateLabel } from './invoicing'

const eur = new Intl.NumberFormat('es-ES', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 })
const money = (c: number) => eur.format(c / 100)
const day = (d?: string | null) => (d ? d.split('-').reverse().join('/') : '')
const INK = rgb(0.1, 0.11, 0.16)
const MUTED = rgb(0.42, 0.44, 0.52)
const LINE = rgb(0.86, 0.87, 0.9)
const ACCENT = rgb(0.35, 0.39, 0.85)

let fonts: Promise<[ArrayBuffer, ArrayBuffer]> | null = null
const loadFonts = () => (fonts ??= Promise.all([regularUrl, boldUrl].map((u) => fetch(u).then((r) => { if (!r.ok) throw new Error('font'); return r.arrayBuffer() }))) as Promise<[ArrayBuffer, ArrayBuffer]>)
  .catch((e) => { fonts = null; throw e })

function wrap(text: string, font: PDFFont, size: number, width: number) {
  const out: string[] = []
  for (const para of text.split(/\r?\n/)) {
    let line = ''
    for (const word of para.split(/\s+/)) {
      const next = line ? `${line} ${word}` : word
      if (font.widthOfTextAtSize(next, size) <= width) { line = next; continue }
      if (line) out.push(line)
      // a single word longer than the column is cut by characters
      let w = word
      while (font.widthOfTextAtSize(w, size) > width && w.length > 1) {
        let cut = w.length - 1
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > width) cut--
        out.push(w.slice(0, cut)); w = w.slice(cut)
      }
      line = w
    }
    out.push(line)
  }
  return out
}

function partyLines(p: PartySnapshot) {
  // «08019 Barcelona (Barcelona)»: the province only when it is filled in
  const place = [p.postalCode, p.city].filter(Boolean).join(' ') + (p.province?.trim() ? (p.postalCode || p.city ? ` (${p.province.trim()})` : p.province.trim()) : '')
  return [p.name, p.taxId ? `NIF: ${p.taxId}` : '', p.address, place, p.country ?? '', p.email ?? '', p.phone ?? ''].filter((l) => l && l.trim())
}

export interface PdfInput {
  invoice: Invoice
  issuer: PartySnapshot & { iban?: string; logo?: string | null }
  client: PartySnapshot
  rectifiesCode?: string | null
}

export async function invoicePdf({ invoice: inv, issuer, client, rectifiesCode }: PdfInput): Promise<Uint8Array> {
  const [regBytes, boldBytes] = await loadFonts()
  const doc = await PDFDocument.create()
  doc.registerFontkit(fontkit)
  const reg = await doc.embedFont(regBytes, { subset: true })
  const bold = await doc.embedFont(boldBytes, { subset: true })
  const draft = inv.status === 'draft'
  const title = inv.rectifiesId ? 'FACTURA RECTIFICATIVA' : 'FACTURA'
  doc.setTitle(`${title} ${inv.code ?? 'borrador'}`)
  doc.setAuthor(issuer.name)
  doc.setCreator('Financy')
  doc.setProducer('Financy')

  const W = 595.28, H = 841.89, M = 48
  let page: PDFPage = doc.addPage([W, H])
  let y = H - M
  const text = (s: string, x: number, yy: number, o: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; right?: boolean } = {}) => {
    const size = o.size ?? 10, font = o.font ?? reg
    const xx = o.right ? x - font.widthOfTextAtSize(s, size) : x
    page.drawText(s, { x: xx, y: yy, size, font, color: o.color ?? INK })
  }
  const watermark = () => { if (draft) page.drawText('BORRADOR', { x: 120, y: 380, size: 86, font: bold, color: rgb(0.93, 0.93, 0.96), rotate: degrees(35) }) }
  watermark()
  const newPage = () => { page = doc.addPage([W, H]); y = H - M; watermark() }
  const need = (h: number) => { if (y - h < M + 40) newPage() }

  // header: logo left, document title and number right
  let logoH = 0
  if (issuer.logo) {
    try {
      const bytes = Uint8Array.from(atob(issuer.logo.split(',')[1]), (c) => c.charCodeAt(0))
      const img = issuer.logo.startsWith('data:image/png') ? await doc.embedPng(bytes) : await doc.embedJpg(bytes)
      const s = Math.min(150 / img.width, 64 / img.height, 1)
      logoH = img.height * s
      page.drawImage(img, { x: M, y: y - logoH, width: img.width * s, height: logoH })
    } catch { /* a broken logo never blocks the invoice */ }
  }
  text(title, W - M, y - 18, { size: 20, font: bold, right: true, color: ACCENT })
  const meta: [string, string][] = [
    ['Nº factura', inv.code ?? '—'],
    ['Fecha de expedición', day(inv.issueDate)],
    ...(rectifiesCode ? [['Rectifica a', rectifiesCode] as [string, string]] : []),
  ]
  let my = y - 40
  for (const [k, v] of meta) { text(k, W - M - 120, my, { size: 9, color: MUTED, right: true }); text(v, W - M, my, { size: 10, font: bold, right: true }); my -= 15 }
  y = Math.min(y - logoH - 20, my - 10)

  // parties
  const colW = (W - 2 * M - 24) / 2
  const block = (label: string, p: PartySnapshot, x: number) => {
    let yy = y
    text(label, x, yy, { size: 8.5, font: bold, color: MUTED }); yy -= 15
    partyLines(p).forEach((l, i) => { for (const w of wrap(l, i ? reg : bold, i ? 9.5 : 11, colW)) { text(w, x, yy, { size: i ? 9.5 : 11, font: i ? reg : bold }); yy -= i ? 13 : 15 } })
    return yy
  }
  const yEnd = Math.min(block('EMISOR', issuer, M), block('CLIENTE', client, M + colW + 24))
  y = yEnd - 18

  // lines table
  const cx = { desc: M + 8, qty: W - M - 190, price: W - M - 95, amount: W - M - 8 }
  const header = () => {
    page.drawRectangle({ x: M, y: y - 8, width: W - 2 * M, height: 24, color: rgb(0.95, 0.95, 0.98) })
    text('Descripción', cx.desc, y, { size: 9, font: bold, color: MUTED })
    text('Cantidad', cx.qty, y, { size: 9, font: bold, color: MUTED, right: true })
    text('Precio', cx.price, y, { size: 9, font: bold, color: MUTED, right: true })
    text('Importe', cx.amount, y, { size: 9, font: bold, color: MUTED, right: true })
    y -= 26
  }
  header()
  for (const l of inv.lines) {
    const rows = wrap(l.description || '—', reg, 10, cx.qty - cx.desc - 60)
    need(rows.length * 13 + 12)
    if (y > H - M - 5) header()
    text(quantityLabel(l.quantity), cx.qty, y, { right: true })
    text(money(l.unitPrice), cx.price, y, { right: true })
    text(money(lineAmount(l)), cx.amount, y, { right: true, font: bold })
    rows.forEach((r, i) => text(r, cx.desc, y - i * 13))
    y -= rows.length * 13 + 6
    page.drawLine({ start: { x: M, y: y + 2 }, end: { x: W - M, y: y + 2 }, thickness: 0.5, color: LINE })
    y -= 8
  }

  // totals
  const t = inv.totals ?? computeTotals(inv.lines, inv.vatRate, inv.irpfRate)
  const rows: [string, string, boolean?][] = [
    ['Base imponible', money(t.base)],
    [`IVA ${rateLabel(inv.vatRate)}`, money(t.vat)],
    ...(inv.irpfRate ? [[`Retención IRPF ${rateLabel(inv.irpfRate)}`, `−${money(t.irpf)}`] as [string, string]] : []),
    ['TOTAL', money(t.total), true],
  ]
  need(rows.length * 18 + 20)
  y -= 4
  for (const [k, v, strong] of rows) {
    if (strong) { y -= 6; page.drawLine({ start: { x: W - M - 230, y: y + 17 }, end: { x: W - M, y: y + 17 }, thickness: 0.8, color: INK }) }
    text(k, W - M - 120, y, { size: strong ? 12 : 10, font: strong ? bold : reg, color: strong ? INK : MUTED, right: true })
    text(v, W - M, y, { size: strong ? 13 : 10, font: bold, right: true })
    y -= strong ? 22 : 16
  }

  // notes: VAT reason, payment, observations
  const notes: [string, string][] = []
  if (inv.vatNote?.trim()) notes.push(['Mención IVA', inv.vatNote.trim()])
  const iban = inv.iban || issuer.iban
  if (iban) notes.push(['Forma de pago', `Transferencia bancaria a ${formatIban(iban)}`])
  if (inv.notes?.trim()) notes.push(['Observaciones', inv.notes.trim()])
  y -= 10
  for (const [k, v] of notes) {
    const r = wrap(v, reg, 9.5, W - 2 * M)
    need(r.length * 13 + 22)
    text(k, M, y, { size: 8.5, font: bold, color: MUTED }); y -= 14
    for (const line of r) { text(line, M, y, { size: 9.5 }); y -= 13 }
    y -= 8
  }

  // footer on every page
  const pages = doc.getPages()
  pages.forEach((p, i) => {
    const f = `${inv.code ?? 'Borrador'} · ${issuer.name} · ${i + 1}/${pages.length}`
    p.drawText(f, { x: W / 2 - reg.widthOfTextAtSize(f, 8) / 2, y: 26, size: 8, font: reg, color: MUTED })
  })
  return doc.save({ useObjectStreams: false })
}

export const pdfFileName = (inv: Invoice) => `${inv.status === 'draft' ? 'borrador' : 'factura'}-${(inv.code ?? inv.issueDate).replace(/[^\w.-]+/g, '_')}.pdf`
