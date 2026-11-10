// Shape checks for synced records. Anything that fails is rejected, never stored.
export const ENTITIES = ['operation', 'client', 'category']
const isStr = (v, max = 2000) => typeof v === 'string' && v.length <= max
const optStr = (v, max) => v === undefined || v === null || isStr(v, max)
const isDate = (v) => isStr(v, 40) && Number.isFinite(Date.parse(v))
const optDate = (v) => v === undefined || v === null || isDate(v)

export function validRecord(entity, r) {
  if (!r || typeof r !== 'object' || Array.isArray(r) || !isStr(r.id, 120) || !r.id) return false
  if (!optDate(r.updatedAt) || !optDate(r.deletedAt) || !optDate(r.createdAt)) return false
  if (entity === 'operation') {
    return (r.type === 'income' || r.type === 'expense') && Number.isSafeInteger(r.amount) && r.amount > 0
      && isStr(r.title, 500) && isDate(r.date) && (r.currency === undefined || /^[A-Za-z]{3}$/.test(r.currency))
      && optStr(r.categoryId, 120) && optStr(r.clientId, 120) && optStr(r.note, 4000)
      && (r.incomeKind === undefined || ['work', 'shoot', 'oneoff'].includes(r.incomeKind))
      && (r.source === undefined || ['manual', 'camera', 'upload', 'import'].includes(r.source))
  }
  if (entity === 'client') return isStr(r.name, 500) && (r.aliases === undefined || (Array.isArray(r.aliases) && r.aliases.every((a) => isStr(a, 500))))
  if (entity === 'category') return isStr(r.name, 200) && (r.type === 'income' || r.type === 'expense')
  return false
}
