// Memory proposals — pure DB state. A memory write an agent may not make on
// its own say (src/memories-http.js decides which) is kept here until the
// user answers the question the journal files for it; the HTTP surface, the
// item, the markers and the sweep live in src/memory-proposals-http.js.
//
//   pending   — waits for the user's tap on its item. At most one per
//               (user, memory name): a newer proposal for the name replaces
//               the older one and gets a new item of its own. A pending
//               row is never rewritten, so the item a user is reading
//               always shows the change its buttons apply.
//   approved  — the user tapped the approving button; the change was applied
//               as proposed.
//   declined  — the user tapped the other button, or closed the item.
//   replaced  — a newer proposal for the same name took its place.
//   expired   — nobody answered within PROPOSAL_TTL_MS.
//   stale     — the user approved it, but the memory it was made against had
//               changed or gone since (or one had appeared where there was
//               none): nothing was applied.
//
// The row holds the change exactly as it will be applied — the scope and
// type a save ends up with included, fixed when it is recorded — and which
// memory it was made against (memory_id, base_updated_at). What the user
// reads on the item is rendered from the row, an approval applies the row,
// and it applies only while the memory is still as it was then, so what was
// shown and what is done cannot differ.
import { randomBytes } from 'node:crypto'
import { getMemory, DEFAULT_SCOPE, DEFAULT_TYPE } from './memories.js'

export const PROPOSAL_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PROPOSAL_ACTIONS = ['save', 'delete']
// How many proposals may wait at once: from one conversation (a write that
// names none counts against its device), and for one user in all. Past
// either, a new proposal is refused ('too_many_asks') until some are
// answered. One that replaces a pending proposal for the same name adds
// nothing and is never refused.
export const MAX_PENDING_PER_CONVO = 10
export const MAX_PENDING_PER_USER = 50
export const SAVE_LABELS = ['Save it', 'Decline']
export const DELETE_LABELS = ['Delete it', 'Keep it']
export const labelsFor = (action) => (action === 'delete' ? DELETE_LABELS : SAVE_LABELS)

const newId = () => `mp_${randomBytes(8).toString('hex')}`

const rowToProposal = (r) => (r ? {
  id: r.id, user_id: r.user_id, name: r.name, action: r.action,
  description: r.description, body: r.body, type: r.type, scope: r.scope, tier: r.tier ?? null, topic: r.topic ?? null, memory_id: r.memory_id,
  from_device_id: r.from_device_id, from_convo_id: r.from_convo_id, item_id: r.item_id,
  state: r.state, created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at,
  base_updated_at: r.base_updated_at ?? null, told_at: r.told_at ?? null,
} : null)

export function getProposal(db, userId, id) {
  return rowToProposal(db.prepare('SELECT * FROM memory_proposals WHERE id=? AND user_id=?').get(id, userId))
}

export function pendingProposalFor(db, userId, name) {
  return rowToProposal(db.prepare("SELECT * FROM memory_proposals WHERE user_id=? AND name=? AND state='pending'").get(userId, name))
}

// The proposal an item asks about, whatever its state.
export function proposalOfItem(db, userId, itemId) {
  return rowToProposal(db.prepare('SELECT * FROM memory_proposals WHERE user_id=? AND item_id=? ORDER BY created_at DESC LIMIT 1').get(userId, itemId))
}

// Record a proposal. `fields` is {description, body, type, scope} for a save
// and ignored for a delete; `memoryId` is the memory a delete names. The
// memory the change is made against is read here, in the same write: a
// save's type and scope are settled now (the proposed value, else that
// memory's, else the default), and its id and updated_at are kept so an
// approval can tell whether it still stands (isStale).
// Returns { proposal, replaced }: `replaced` is the pending proposal for
// this name that the new one set aside, whoever made it, or null. The caller
// files a new item, closes the older one's and tells its conversation.
// Throws Error('too_many_asks') at a cap; nothing is written then.
export function recordProposal(db, { userId, name, action, fields = {}, memoryId = null, fromDeviceId, fromConvoId = null, now = Date.now() }) {
  return db.transaction(() => {
    const save = action === 'save'
    const base = getMemory(db, userId, save ? name : memoryId)
    const vals = {
      description: save ? fields.description : '', body: save ? (fields.body ?? '') : '',
      type: save ? (fields.type ?? base?.type ?? DEFAULT_TYPE) : null, scope: save ? (fields.scope ?? base?.scope ?? DEFAULT_SCOPE) : null,
      // tier as asked (null = not named: an update keeps the stored tier, a
      // create takes the default unless the cap places it on_demand); topic
      // resolved like scope ('' = cleared).
      tier: save ? (fields.tier ?? null) : null,
      topic: save ? (fields.topic === undefined ? (base?.topic ?? null) : fields.topic) : null,
    }
    const old = pendingProposalFor(db, userId, name)
    if (old) {
      db.prepare("UPDATE memory_proposals SET state='replaced', updated_at=? WHERE id=?").run(now, old.id)
    } else {
      const mine = fromConvoId != null
        ? db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE user_id=? AND state='pending' AND from_convo_id=?").get(userId, fromConvoId).n
        : db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE user_id=? AND state='pending' AND from_convo_id IS NULL AND from_device_id=?").get(userId, fromDeviceId).n
      if (mine >= MAX_PENDING_PER_CONVO) throw new Error('too_many_asks')
      const all = db.prepare("SELECT COUNT(*) AS n FROM memory_proposals WHERE user_id=? AND state='pending'").get(userId).n
      if (all >= MAX_PENDING_PER_USER) throw new Error('too_many_asks')
    }
    const id = newId()
    db.prepare(`INSERT INTO memory_proposals(id, user_id, name, action, description, body, type, scope, tier, topic, memory_id, base_updated_at, from_device_id, from_convo_id, state, created_at, updated_at, expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?,?)`)
      .run(id, userId, name, action, vals.description, vals.body, vals.type, vals.scope, vals.tier, vals.topic, base?.id ?? null, base?.updated_at ?? null, fromDeviceId, fromConvoId, now, now, now + PROPOSAL_TTL_MS)
    return { proposal: getProposal(db, userId, id), replaced: old ? { ...old, state: 'replaced' } : null }
  })()
}

export function setProposalItem(db, id, itemId) {
  db.prepare('UPDATE memory_proposals SET item_id=? WHERE id=?').run(itemId, id)
}

// pending → `state`, once, in one statement: of two writers (a tap and a
// newer proposal replacing this one, or two taps) exactly one succeeds.
// Returns the row as it now stands, or null when it was not pending
// (answered, replaced or expired already) or has run out and only waits for
// the sweep. `itemId`, when given, must be the item the proposal is bound
// to: a tap settles only the proposal its own item asks about.
export function settleProposal(db, { userId, id, state, itemId = null, now = Date.now() }) {
  const live = state === 'expired' ? '' : 'AND expires_at > ?'
  const bound = itemId == null ? '' : 'AND item_id = ?'
  const args = [state, now, id, userId, ...(state === 'expired' ? [] : [now]), ...(itemId == null ? [] : [itemId])]
  const r = db.prepare(`UPDATE memory_proposals SET state=?, updated_at=? WHERE id=? AND user_id=? AND state='pending' ${live} ${bound}`).run(...args)
  return r.changes ? getProposal(db, userId, id) : null
}

// Is the memory no longer as it was when the proposal was recorded? A save:
// the name must still hold the same memory with the same updated_at, or
// still hold none. A delete: the memory must still be there, unchanged.
export function isStale(db, p) {
  const now = getMemory(db, p.user_id, p.action === 'delete' ? (p.memory_id ?? '') : p.name)
  if (p.action === 'delete' && !now) return true
  return (now?.id ?? null) !== (p.memory_id ?? null) || (now?.updated_at ?? null) !== (p.base_updated_at ?? null)
}

// The sweep: proposals nobody answered in time, flipped to 'expired' in one
// statement — all of them or none.
export function expireProposals(db, now = Date.now()) {
  return db.prepare("UPDATE memory_proposals SET state='expired', updated_at=? WHERE state='pending' AND expires_at <= ? RETURNING *").all(now, now).map(rowToProposal)
}

// The proposing conversation has been told how it ended (or there is none).
export function markTold(db, id, now = Date.now()) {
  db.prepare('UPDATE memory_proposals SET told_at=? WHERE id=? AND told_at IS NULL').run(now, id)
}

// Settled proposals with something still owed: the proposer not told, or the
// item still open. Looked for only for FOLLOW_UP_MS after the settlement; a
// conversation that is gone is not retried for ever.
export const FOLLOW_UP_MS = 24 * 60 * 60 * 1000
export function owedFollowUps(db, now = Date.now()) {
  return db.prepare(`SELECT p.* FROM memory_proposals p
    WHERE p.state != 'pending' AND p.updated_at > ?
      AND (p.told_at IS NULL OR EXISTS (SELECT 1 FROM items i WHERE i.id = p.item_id AND i.state = 'open'))
    ORDER BY p.updated_at, p.rowid`).all(now - FOLLOW_UP_MS).map(rowToProposal)
}

// Settled rows are kept a while for the record, then dropped.
export function pruneProposals(db, now = Date.now(), keepMs = 30 * 24 * 60 * 60 * 1000) {
  return db.prepare("DELETE FROM memory_proposals WHERE state != 'pending' AND updated_at < ?").run(now - keepMs).changes
}
