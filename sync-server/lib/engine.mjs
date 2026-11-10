// Pure sync logic: no I/O, so every rule is unit-tested (test/engine.test.mjs).
//
// Each record has a server revision (`rev`, from a global counter `seq`). A device pushes a change
// together with the revision it was based on (`baseRev`):
//   - same content as the server            → idempotent no-op (safe to resend after a lost reply)
//   - baseRev equals the server revision    → fast-forward
//   - otherwise both sides changed           → three-way merge per field against the base version;
//     fields changed on one side only merge silently; a field changed differently on both sides is a
//     conflict: the newer edit is kept (an edit always beats a deletion) and BOTH versions are saved
//     in `conflicts` for the user to review. Nothing is silently lost.
import { movementError } from './planning.mjs'
import { canonical, hashRecord } from './canonical.mjs'
import { ENTITIES, validRecord } from './records.mjs'

export const MAX_VERSIONS = 10
const META = new Set(['updatedAt', 'createdAt'])

export const emptyDb = (serverId) => ({ format: 1, serverId, seq: 0, records: {}, versions: {}, conflicts: [], lastChangeAt: null })
export const keyOf = (entity, id) => `${entity}:${id}`

/** Serial, idempotent reserve commands. Never accept reserve balances through generic LWW. */
export function commitPlanning(input, deviceId, event, baseSeq, now = new Date().toISOString()) {
  if (!validRecord('planning', event) || event.kind !== 'movement' || event.deletedAt) return { error: 'invalid-planning' }
  const key = keyOf('planning', event.id)
  const previous = input.records[key]
  if (previous) {
    const sameCommand = ['kind', 'currency', 'amount', 'from', 'to', 'createdAt'].every((field) => same(previous.data[field], event[field]))
    return sameCommand ? { db: input, record: previous } : { error: 'planning-id-conflict' }
  }
  if (baseSeq !== input.seq) return { error: 'planning-stale' }
  const data = snapshot(input)
  const error = movementError(data.operations, data.planning, event, new Date(now))
  if (error) return { error: 'planning-funds' }
  const db = structuredClone(input)
  const confirmed = { ...event, status: 'confirmed', reason: undefined, updatedAt: now }
  delete confirmed.reason
  const record = { entity: 'planning', id: event.id, rev: ++db.seq, hash: hashRecord(confirmed), data: confirmed, deviceId, at: now }
  db.records[key] = record
  db.lastChangeAt = now
  return { db, record }
}
const same = (a, b) => canonical(a) === canonical(b)
const maxIso = (a, b) => ((a ?? '') > (b ?? '') ? a : b)

function findVersion(db, key, rev) {
  const cur = db.records[key]
  if (cur?.rev === rev) return cur
  return db.versions[key]?.find((v) => v.rev === rev)
}

/** Three-way merge. Returns the merged record and the list of truly conflicting fields. */
export function merge(base, server, client) {
  const fields = new Set([...Object.keys(server), ...Object.keys(client)])
  const out = {}
  const conflicts = []
  for (const f of fields) {
    if (META.has(f)) continue
    const s = server[f]; const c = client[f]; const b = base?.[f]
    if (same(s ?? null, c ?? null)) out[f] = s
    else if (f === 'deletedAt' && s && c) out[f] = s // deleted on both devices: not a conflict
    else if (base && same(b ?? null, s ?? null)) out[f] = c
    else if (base && same(b ?? null, c ?? null)) out[f] = s
    else conflicts.push(f)
  }
  // One side deleted while the other edited the content: keeping the edit is the safe choice.
  if (base && !conflicts.includes('deletedAt') && !!server.deletedAt !== !!client.deletedAt) {
    const editor = server.deletedAt ? client : server
    const edited = [...fields].some((f) => !META.has(f) && f !== 'deletedAt' && !same(base[f] ?? null, editor[f] ?? null))
    if (edited) conflicts.push('deletedAt')
  }
  return { out, conflicts }
}

/**
 * Applies one push from a device to a copy of the database.
 * @returns {{ db, results: object[], changed: boolean }}
 */
export function applyPush(input, deviceId, changes, now = new Date().toISOString()) {
  const db = structuredClone(input)
  const results = []
  let changed = false
  const store = (entity, id, data, extra = {}) => {
    const key = keyOf(entity, id)
    const prev = db.records[key]
    if (prev) db.versions[key] = [{ rev: prev.rev, hash: prev.hash, data: prev.data }, ...(db.versions[key] ?? [])].slice(0, MAX_VERSIONS)
    const rec = { entity, id, rev: ++db.seq, hash: hashRecord(data), data, deviceId, at: now, ...extra }
    db.records[key] = rec
    db.lastChangeAt = now
    changed = true
    return rec
  }
  for (const ch of changes) {
    const { entity, id, baseRev = 0, hash, data } = ch ?? {}
    const key = keyOf(entity, id)
    if ((entity === 'planning' && (data?.kind === 'movement' || db.records[key]?.data.kind === 'movement')) || !ENTITIES.includes(entity) || !data || data.id !== id || !validRecord(entity, data)) {
      results.push({ key, status: 'rejected', reason: 'invalid' }); continue
    }
    if (hashRecord(data) !== hash) { results.push({ key, status: 'rejected', reason: 'integrity' }); continue }
    const cur = db.records[key]
    if (!cur) { const r = store(entity, id, data); results.push({ key, status: 'accepted', rev: r.rev, hash: r.hash }); continue }
    if (cur.hash === hash) { results.push({ key, status: 'same', rev: cur.rev, hash: cur.hash }); continue }
    if (baseRev === cur.rev) { const r = store(entity, id, data); results.push({ key, status: 'accepted', rev: r.rev, hash: r.hash }); continue }

    // Both sides changed since the device last saw this record.
    const base = baseRev > 0 ? findVersion(db, key, baseRev)?.data : undefined
    const { out, conflicts } = merge(base, cur.data, data)
    const updatedAt = maxIso(cur.data.updatedAt, data.updatedAt)
    const createdAt = cur.data.createdAt ?? data.createdAt
    if (!conflicts.length) {
      const merged = { ...out, ...(createdAt ? { createdAt } : {}), ...(updatedAt ? { updatedAt } : {}) }
      if (hashRecord(merged) === cur.hash) { results.push({ key, status: 'same', rev: cur.rev, hash: cur.hash, data: cur.data }); continue }
      const r = store(entity, id, merged)
      results.push({ key, status: 'merged', rev: r.rev, hash: r.hash, data: merged })
      continue
    }
    // True conflict. An edit beats a deletion; otherwise the newer edit wins.
    const deletedOnly = conflicts.length === 1 && conflicts[0] === 'deletedAt'
    let winnerIsClient = (data.updatedAt ?? '') > (cur.data.updatedAt ?? '')
    if (conflicts.includes('deletedAt')) winnerIsClient = !data.deletedAt
    const winner = winnerIsClient ? data : cur.data
    const resolved = { ...out, ...Object.fromEntries(conflicts.map((f) => [f, winner[f]])), ...(createdAt ? { createdAt } : {}), updatedAt: maxIso(updatedAt, now) }
    for (const f of Object.keys(resolved)) if (resolved[f] === undefined) delete resolved[f]
    const r = store(entity, id, resolved)
    if (!deletedOnly || entity === 'operation') {
      db.conflicts.push({
        id: `cf-${r.rev}`, key, entity, recordId: id, at: now, fields: conflicts, resolved: false,
        kept: { data: resolved, deviceId: winnerIsClient ? deviceId : cur.deviceId },
        other: { data: winnerIsClient ? cur.data : data, deviceId: winnerIsClient ? cur.deviceId : deviceId },
      })
    }
    results.push({ key, status: 'conflict', rev: r.rev, hash: r.hash, data: resolved, fields: conflicts })
  }
  return { db, results, changed }
}

/** Records changed after `since`, oldest first, in pages. */
export function pull(db, since = 0, limit = 500, planning = true) {
  const all = Object.values(db.records).filter((r) => r.rev > since && (planning || r.entity !== 'planning')).sort((a, b) => a.rev - b.rev)
  const page = all.slice(0, limit)
  return {
    records: page.map(({ entity, id, rev, hash, data }) => ({ entity, id, rev, hash, data })),
    cursor: page.length ? page[page.length - 1].rev : since,
    more: all.length > limit,
    seq: db.seq,
  }
}

export function openConflicts(db) {
  return db.conflicts.filter((c) => !c.resolved).slice(-100)
}

export function resolveConflict(input, id, now = new Date().toISOString()) {
  const db = structuredClone(input)
  const c = db.conflicts.find((x) => x.id === id)
  if (!c) return { db, ok: false }
  c.resolved = true
  c.resolvedAt = now
  // keep the file small: drop resolved conflicts older than 90 days
  const cutoff = new Date(Date.parse(now) - 90 * 864e5).toISOString()
  db.conflicts = db.conflicts.filter((x) => !x.resolved || (x.resolvedAt ?? x.at) > cutoff)
  return { db, ok: true }
}

/** Live and deleted records grouped like the app's JSON backup. */
export function snapshot(db) {
  const out = { operations: [], clients: [], categories: [], planning: [] }
  const name = { operation: 'operations', client: 'clients', category: 'categories', planning: 'planning' }
  for (const r of Object.values(db.records)) out[name[r.entity]].push(r.data)
  for (const list of Object.values(out)) list.sort((a, b) => a.id.localeCompare(b.id))
  return out
}
