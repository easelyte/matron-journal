// Memories — pure DB state (spec: 2026-09-27 memories). The user's shared
// agent memory: one row per name, overwritten by PUT. No hub, no marker,
// no auth here: src/memories-http.js owns those, the items.js split.
import { randomBytes } from 'node:crypto'
import { isPrivateDevice } from './db.js'

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference']
export const DEFAULT_TYPE = 'feedback'
export const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/
export const DESCRIPTION_MAX = 200
export const BODY_MAX = 8192 // bytes
export const MEMORIES_MAX = 200
// Scopes (spec 2026-10-01 memory scopes): who a memory is for. `global` is
// every session (how every memory worked before scopes), `coordinator` the
// user's Coordinator only, `repo:<name>` the sessions whose working
// directory is a checkout of that repo — the bare repo name, as the bridge
// derives it from the git remote (or the directory). The name part is the
// `name` segment of src/repo-identity.js's canonical form.
export const DEFAULT_SCOPE = 'global'
export const SCOPE_MAX = 128
export const SCOPE_RE = /^(global|coordinator|repo:[A-Za-z0-9_.-]+)$/
export const validScope = (v) => typeof v === 'string' && v.length <= SCOPE_MAX && SCOPE_RE.test(v)

// C0/C1 controls (covers \n, \r, \t) and the Unicode line/paragraph
// separators — the description is the one line the Coordinator sees at
// spawn, so it must stay a line. Same set the item-actions rule uses.
const LINE_BAD_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/

export const newId = () => `me_${randomBytes(8).toString('hex')}`
export const validName = (v) => typeof v === 'string' && NAME_RE.test(v)

// {ok:false} on any bad field. body omitted → '' (a PUT is the whole memory).
// type and scope omitted → undefined: upsertMemory keeps the stored value on
// an update and applies DEFAULT_TYPE / DEFAULT_SCOPE on a create.
export function validateMemoryFields(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return { ok: false }
  const { description, body: text, type, scope } = body
  if (typeof description !== 'string') return { ok: false }
  const desc = description.trim()
  if (!desc || desc.length > DESCRIPTION_MAX || LINE_BAD_CHARS.test(desc)) return { ok: false }
  let value = ''
  if (text !== undefined) {
    if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > BODY_MAX) return { ok: false }
    value = text
  }
  if (type !== undefined && !MEMORY_TYPES.includes(type)) return { ok: false }
  if (scope !== undefined && !validScope(scope)) return { ok: false }
  return { ok: true, value: { description: desc, body: value, type, scope } }
}

const rowToMemory = (r) => (r ? {
  id: r.id, user_id: r.user_id, name: r.name, type: r.type, scope: r.scope ?? DEFAULT_SCOPE, description: r.description, body: r.body,
  origin_convo_id: r.origin_convo_id, origin_device_id: r.origin_device_id, origin_private: !!r.origin_private,
  created_by: r.created_by, updated_by: r.updated_by, created_at: r.created_at, updated_at: r.updated_at,
} : null)

// `key` is the id (me_…) or the name; both are unique per user.
export function getMemory(db, userId, key) {
  if (typeof key !== 'string' || !key) return null
  const col = key.startsWith('me_') ? 'id' : 'name'
  return rowToMemory(db.prepare(`SELECT * FROM memories WHERE user_id=? AND ${col}=?`).get(userId, key))
}

export function listMemories(db, userId, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned ? 'AND m.origin_private = 0' : ''
  return db.prepare(`SELECT * FROM memories m WHERE m.user_id=? ${sieve} ORDER BY m.name`).all(userId).map(rowToMemory)
}

// Saved from a private device → hidden from an ordinary agent (the
// privateOwnedConvo rule, applied to the memory's own origin device). Read
// from the snapshot taken at save time, never a live devices join: the
// device may be revoked (its row deleted, its id possibly reused) long
// after the memory was saved, and that must not change who may read it.
export const privateOrigin = (memory) => memory?.origin_private === true

// Create or overwrite by name in one transaction. Throws Error('too_many')
// when a CREATE would pass MEMORIES_MAX; an update is never refused.
export function upsertMemory(db, { userId, name, description, body, type, scope, originConvoId = null, originDeviceId = null, by, now = Date.now() }) {
  const originPrivate = originDeviceId != null && isPrivateDevice(db, originDeviceId) ? 1 : 0
  return db.transaction(() => {
    const existing = db.prepare('SELECT * FROM memories WHERE user_id=? AND name=?').get(userId, name)
    if (existing) {
      db.prepare('UPDATE memories SET description=?, body=?, type=?, scope=?, updated_by=?, updated_at=? WHERE id=?')
        .run(description, body, type ?? existing.type, scope ?? existing.scope ?? DEFAULT_SCOPE, by, now, existing.id)
      return { memory: getMemory(db, userId, existing.id), created: false }
    }
    const n = db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id=?').get(userId).n
    if (n >= MEMORIES_MAX) throw new Error('too_many')
    const id = newId()
    db.prepare(`INSERT INTO memories(id, user_id, name, type, scope, description, body, origin_convo_id, origin_device_id, origin_private, created_by, updated_by, created_at, updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, userId, name, type ?? DEFAULT_TYPE, scope ?? DEFAULT_SCOPE, description, body, originConvoId, originDeviceId, originPrivate, by, by, now, now)
    return { memory: getMemory(db, userId, id), created: true }
  })()
}

// The deleted row, or null when there was nothing to delete.
export function deleteMemory(db, userId, id) {
  return db.transaction(() => {
    const m = getMemory(db, userId, id)
    if (!m) return null
    db.prepare('DELETE FROM memories WHERE id=?').run(m.id)
    return m
  })()
}
