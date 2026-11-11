// Recognised document text → client tax details. Only values actually found in the text are returned;
// anything not found stays empty (never guessed). Every returned value is meant to be reviewed.
import { cleanIban, cleanTaxId, formatIban, taxIdKind, validIban } from './invoicing'

export interface ClientFields {
  legalName?: string
  taxId?: string
  address?: string
  postalCode?: string
  city?: string
  /** only when written in the text (e.g. «08019 Barcelona (Barcelona)», «Provincia: Navarra») */
  province?: string
  email?: string
  phone?: string
}
export interface ClientRecognition {
  fields: ClientFields
  /** taxId was read but its control character does not match */
  taxIdInvalid?: boolean
  /** recognised IBAN of the document, if any (shown only as information) */
  iban?: string
  /** cleaned text lines the user can tap to fill a field by hand */
  lines: string[]
}

const NAME_LABEL = /^(raz[oó]n\s+social|denominaci[oó]n(\s+social)?|nombre(\s+y\s+apellidos)?|cliente|empresa|titular|company|name)\s*[:.-]?\s*/i
const COMPANY = /\b(S\.?\s?L\.?\s?U?\.?|S\.?\s?A\.?\s?U?\.?|S\.?\s?COOP\.?|S\.?\s?C\.?|SOCIEDAD\s+LIMITADA|SOCIEDAD\s+AN[OÓ]NIMA|LTD|GMBH|SRL|SAS)\s*$/i
const STREET = /\b(c\/|calle|avda\.?|avenida|av\.|plaza|pza\.?|paseo|p[ºo]\.?|carrer|camino|ctra\.?|carretera|traves[ií]a|ronda|v[ií]a|urb\.?|urbanizaci[oó]n|pol[ií]gono|c\.\s?c\.)\b/i
const TAX_LABEL = /\b(n\.?\s?i\.?\s?f|n\.?\s?i\.?\s?e|c\.?\s?i\.?\s?f|dni|vat|cif\/nif|nif\/cif)\b\.?\s*[:.-]?\s*/i

function candidatesTaxId(line: string): string[] {
  const out: string[] = []
  const re = /\b(ES[\s.-]?)?([A-Z][\s.-]?\d{2}[\s.-]?\d{3}[\s.-]?\d{2,3}[\s.-]?[A-Z0-9]?|\d{8}[\s.-]?[A-Z])\b/gi
  for (const m of line.matchAll(re)) {
    const v = cleanTaxId(m[0])
    if (v.length >= 9 && v.length <= 11) out.push(v.startsWith('ES') && v.length === 11 ? v.slice(2) : v)
  }
  return out
}

/** The 52 Spanish provinces with common spellings (Castilian / co-official), as written on documents. */
const PROVINCES: [string, string[]][] = [
  ['Álava', ['alava', 'araba']], ['Albacete', ['albacete']], ['Alicante', ['alicante', 'alacant']], ['Almería', ['almeria']], ['Asturias', ['asturias']], ['Ávila', ['avila']],
  ['Badajoz', ['badajoz']], ['Barcelona', ['barcelona']], ['Bizkaia', ['bizkaia', 'vizcaya']], ['Burgos', ['burgos']], ['Cáceres', ['caceres']], ['Cádiz', ['cadiz']],
  ['Cantabria', ['cantabria']], ['Castellón', ['castellon', 'castello']], ['Ciudad Real', ['ciudad real']], ['Córdoba', ['cordoba']], ['A Coruña', ['a coruna', 'la coruna', 'coruna']],
  ['Cuenca', ['cuenca']], ['Gipuzkoa', ['gipuzkoa', 'guipuzcoa']], ['Girona', ['girona', 'gerona']], ['Granada', ['granada']], ['Guadalajara', ['guadalajara']], ['Huelva', ['huelva']],
  ['Huesca', ['huesca']], ['Illes Balears', ['illes balears', 'islas baleares', 'baleares', 'balears']], ['Jaén', ['jaen']], ['León', ['leon']], ['Lleida', ['lleida', 'lerida']],
  ['Lugo', ['lugo']], ['Madrid', ['madrid']], ['Málaga', ['malaga']], ['Murcia', ['murcia']], ['Navarra', ['navarra', 'nafarroa']], ['Ourense', ['ourense', 'orense']],
  ['Palencia', ['palencia']], ['Las Palmas', ['las palmas']], ['Pontevedra', ['pontevedra']], ['La Rioja', ['la rioja', 'rioja']], ['Salamanca', ['salamanca']],
  ['Santa Cruz de Tenerife', ['santa cruz de tenerife', 'tenerife']], ['Segovia', ['segovia']], ['Sevilla', ['sevilla']], ['Soria', ['soria']], ['Tarragona', ['tarragona']],
  ['Teruel', ['teruel']], ['Toledo', ['toledo']], ['Valencia', ['valencia']], ['Valladolid', ['valladolid']], ['Zamora', ['zamora']], ['Zaragoza', ['zaragoza']],
  ['Ceuta', ['ceuta']], ['Melilla', ['melilla']],
]
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim()
const provinceOf = (s: string) => { const f = fold(s); return PROVINCES.find(([, names]) => names.includes(f))?.[0] }

/**
 * A province only when the text states it: after a «Provincia» label, in brackets or after a comma
 * next to the city, or alone on its own line. A city that merely shares the province's name
 * (Barcelona, Madrid…) is not taken as the province.
 */
function findProvince(lines: string[], city?: string) {
  for (const l of lines) {
    const m = l.match(/^provincia\s*[:.-]?\s*(.+)$/i)
    if (m && provinceOf(m[1])) return provinceOf(m[1])
  }
  for (const l of lines) {
    if (!/\b\d{5}\b/.test(l) && !(city && l.includes(city))) continue
    const br = l.match(/\(([^)]{2,40})\)/)
    if (br && provinceOf(br[1])) return provinceOf(br[1])
    const parts = l.split(/[,–-]/).map((x) => x.trim()).filter(Boolean)
    for (const part of parts.slice(1)) {
      const pv = provinceOf(part.replace(/\b(espa[nñ]a|spain)\b/i, ''))
      if (pv && (!city || fold(part) !== fold(city))) return pv
    }
  }
  for (const l of lines) {
    const pv = provinceOf(l)
    if (pv && (!city || fold(l) !== fold(city))) return pv
  }
  return undefined
}

export function recognizeClient(text: string): ClientRecognition {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 2)
  const fields: ClientFields = {}
  let taxIdInvalid = false

  // NIF / NIE / CIF: prefer a value with a valid control character; labelled lines first
  const ordered = [...lines.filter((l) => TAX_LABEL.test(l)), ...lines.filter((l) => !TAX_LABEL.test(l))]
  const cands = ordered.flatMap(candidatesTaxId)
  const valid = cands.find((c) => taxIdKind(c))
  if (valid) fields.taxId = valid
  else if (cands.length && ordered.some((l) => TAX_LABEL.test(l) && candidatesTaxId(l).length)) {
    fields.taxId = candidatesTaxId(ordered.find((l) => TAX_LABEL.test(l) && candidatesTaxId(l).length)!)[0]
    taxIdInvalid = true
  }

  const email = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)
  if (email) fields.email = email[0].toLowerCase()

  for (const l of lines) {
    const m = l.match(/(?:\+|00)34[\s.-]?([6789]\d{2})[\s.-]?(\d{3})[\s.-]?(\d{3})\b|\b([6789]\d{2})[\s.-]?(\d{2,3})[\s.-]?(\d{2,3})[\s.-]?(\d{0,3})\b/)
    if (!m) continue
    const digits = m[0].replace(/\D/g, '').replace(/^(0034|34)/, '')
    if (digits.length === 9 && !(fields.taxId && fields.taxId.includes(digits))) { fields.phone = m[0].trim(); break }
  }

  for (const l of lines) {
    const m = l.match(/\b((?:0[1-9]|[1-4]\d|5[0-2])\d{3})\s*[,-]?\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ' .()-]{1,60})/)
    if (m && !/^\d+$/.test(m[2])) { fields.postalCode = m[1]; fields.city = m[2].replace(/\s*\(.*$/, '').replace(/\s*,.*$/, '').trim(); break }
  }

  const province = findProvince(lines, fields.city)
  if (province) fields.province = province

  const street = lines.find((l) => STREET.test(l))
  if (street) fields.address = street.replace(/^(domicilio(\s+fiscal)?|direcci[oó]n|address)\s*[:.-]?\s*/i, '')

  // name: after an explicit label, or a line ending in a company form (S.L., S.A., …)
  for (let i = 0; i < lines.length && !fields.legalName; i++) {
    const l = lines[i]
    if (NAME_LABEL.test(l)) {
      const rest = l.replace(NAME_LABEL, '').trim()
      if (rest.length >= 2) fields.legalName = rest
      else if (lines[i + 1] && !TAX_LABEL.test(lines[i + 1])) fields.legalName = lines[i + 1]
    }
  }
  if (!fields.legalName) {
    const company = lines.find((l) => COMPANY.test(l) && !STREET.test(l) && l.length <= 120)
    if (company) fields.legalName = company
  }

  let iban: string | undefined
  const ib = text.toUpperCase().match(/\b[A-Z]{2}\d{2}(?:[\s-]?[0-9A-Z]{4}){4,7}(?:[\s-]?[0-9A-Z]{1,4})?\b/)
  if (ib && validIban(cleanIban(ib[0]))) iban = formatIban(ib[0])

  return { fields, taxIdInvalid, iban, lines: lines.slice(0, 40) }
}
