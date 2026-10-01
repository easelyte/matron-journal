// Read state (spec 2026-09-30 read state): what the user has actually SEEN,
// and what the Coordinator (or an agent, about its own messages) may raise
// with them. Deliberately apart from read_marker/unread_count — those stay
// the badge's business; nothing here touches unread, push or the snippet.
//
// Seen is reported by the user's client apps as seq ranges per conversation
// (op `seen`, src/ws.js). A client that doesn't send ranges yet — web and
// Android, old Apple builds — gets the legacy fallback: its read_marker
// counts as "seen up to that seq" until the device sends its first `seen`.
import { isClientOnlyEvent, snippetOf } from './journal.js'
import { getCoordinatorConvoId } from './coordinator.js'

// The content a person reads. tool_output and diff are working output; the
// item marker is covered by the item itself.
export const UNSEEN_TYPES = ['text', 'prompt', 'permission_request', 'file', 'image', 'spawn_outcome']
const UNSEEN_TYPES_SQL = UNSEEN_TYPES.map((t) => `'${t}'`).join(',')

export const SEEN_RANGES_MAX = 64
export const REFS_MAX = 100
export const UNSEEN_LIMIT_MAX = 200
// Candidate rows read before filtering; hitting it sets `truncated`.
const SCAN_MAX = 20000
const SEQ_MAX = Number.MAX_SAFE_INTEGER
const REF_MSG = /^msg:(.{1,128}):(\d{1,16})$/
const REF_ITEM = /^item:([A-Za-z0-9_-]{1,64}):(\d{1,16})$/

// `[[from, to], ...]`, each 1 <= from <= to. Empty is valid (a device
// announcing that it reports ranges). null = malformed.
export function validRanges(ranges) {
  if (!Array.isArray(ranges) || ranges.length > SEEN_RANGES_MAX) return null
  const out = []
  for (const r of ranges) {
    if (!Array.isArray(r) || r.length !== 2) return null
    const [a, b] = r
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a || b > SEQ_MAX) return null
    out.push([a, b])
  }
  return out
}

export const validRef = (ref) => typeof ref === 'string' && (REF_MSG.test(ref) || REF_ITEM.test(ref))

export function parseRef(ref) {
  let m = REF_MSG.exec(ref)
  if (m) return { kind: 'message', convoId: m[1], seq: Number(m[2]) }
  m = REF_ITEM.exec(ref)
  if (m) return { kind: 'item', itemId: m[1], at: Number(m[2]) }
  return null
}

export const usesRanges = (db, deviceId) =>
  !!db.prepare('SELECT 1 FROM seen_devices WHERE device_id=?').get(deviceId)

export function markDeviceUsesRanges(db, deviceId, now = Date.now()) {
  db.prepare('INSERT OR IGNORE INTO seen_devices(device_id, first_at) VALUES(?,?)').run(deviceId, now)
}

// True when no content event (by someone other than the user) of this
// conversation lies strictly between the two seqs, so two ranges either side
// of the gap read as one: seqs are per user, not per conversation, and the
// gap is other conversations' events (or the user's own messages).
function gapIsEmpty(db, userId, convoId, afterSeq, beforeSeq) {
  if (beforeSeq <= afterSeq + 1) return true
  // INDEXED BY: left to itself SQLite walks the (user_id, seq) primary key,
  // i.e. every event the user has in the gap across all conversations.
  return !db.prepare(
    `SELECT 1 FROM events INDEXED BY idx_events_convo WHERE convo_id=? AND seq>? AND seq<? AND user_id=?
       AND type IN (${UNSEEN_TYPES_SQL}) AND sender NOT LIKE 'user:%' LIMIT 1`
  ).get(convoId, afterSeq, beforeSeq, userId)
}

// Adds ranges for a conversation the user owns and coalesces the stored set.
// Ranges past the conversation's head are clipped (a client can't have seen
// what doesn't exist yet). Throws 'not_found' for a missing or foreign convo.
export function addSeenRanges(db, userId, convoId, ranges, now = Date.now()) {
  return db.transaction(() => {
    const convo = db.prepare('SELECT owner_user_id, last_seq FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== userId) throw new Error('not_found')
    const add = []
    for (const [a, b] of ranges) {
      if (a > convo.last_seq) continue
      add.push({ from_seq: a, to_seq: Math.min(b, convo.last_seq), seen_at: now })
    }
    if (add.length === 0) return { changed: false }
    const rows = db.prepare('SELECT from_seq, to_seq, seen_at FROM seen_ranges WHERE user_id=? AND convo_id=?').all(userId, convoId)
    const all = [...rows, ...add].sort((x, y) => x.from_seq - y.from_seq)
    const merged = []
    for (const r of all) {
      const last = merged[merged.length - 1]
      if (last && (r.from_seq <= last.to_seq + 1 || gapIsEmpty(db, userId, convoId, last.to_seq, r.from_seq))) {
        last.to_seq = Math.max(last.to_seq, r.to_seq)
        last.seen_at = Math.min(last.seen_at, r.seen_at)
      } else {
        merged.push({ ...r })
      }
    }
    db.prepare('DELETE FROM seen_ranges WHERE user_id=? AND convo_id=?').run(userId, convoId)
    const ins = db.prepare('INSERT INTO seen_ranges(user_id, convo_id, from_seq, to_seq, seen_at) VALUES(?,?,?,?,?)')
    for (const r of merged) ins.run(userId, convoId, r.from_seq, r.to_seq, r.seen_at)
    return { changed: true }
  })()
}

export function seenRanges(db, userId, convoId) {
  return db.prepare('SELECT from_seq, to_seq, seen_at FROM seen_ranges WHERE user_id=? AND convo_id=? ORDER BY from_seq').all(userId, convoId)
    .map((r) => [r.from_seq, r.to_seq])
}

// The legacy fallback: a client read_marker from a device that has never
// sent `seen` counts as having seen the conversation up to that seq. Never
// throws (the read_marker itself already committed).
export function legacyReadAsSeen(db, userId, convoId, deviceId, upToSeq, now = Date.now()) {
  try {
    if (!Number.isInteger(upToSeq) || upToSeq < 1 || usesRanges(db, deviceId)) return false
    return addSeenRanges(db, userId, convoId, [[1, upToSeq]], now).changed
  } catch (err) {
    console.error('seen: legacy read fallback failed (the read marker stands)', err)
    return false
  }
}

// Item threads: seen through the newest comment rendered. Monotonic.
// Throws 'not_found' for a missing or foreign item.
export function markItemSeen(db, userId, itemId, throughCommentAt, now = Date.now()) {
  const item = db.prepare('SELECT user_id FROM items WHERE id=?').get(itemId)
  if (!item || item.user_id !== userId) throw new Error('not_found')
  db.prepare(
    `INSERT INTO item_seen(user_id, item_id, seen_through_comment_at, seen_at) VALUES(?,?,?,?)
     ON CONFLICT(user_id, item_id) DO UPDATE SET
       seen_through_comment_at=MAX(seen_through_comment_at, excluded.seen_through_comment_at)`
  ).run(userId, itemId, throughCommentAt, now)
}

export function flagRefs(db, userId, refs, convoId, now = Date.now()) {
  const ins = db.prepare('INSERT OR IGNORE INTO unseen_flags(user_id, ref, flagged_at, flagged_in_convo_id) VALUES(?,?,?,?)')
  let added = 0
  db.transaction(() => { for (const ref of refs) added += ins.run(userId, ref, now, convoId).changes })()
  return added
}

export function pruneFlags(db, olderThanMs, now = Date.now()) {
  return db.prepare('DELETE FROM unseen_flags WHERE flagged_at<?').run(now - olderThanMs).changes
}

// Smallest seq whose event is at or after `ts`, found by binary search over
// the (user_id, seq) primary key: ts is stamped in the same transaction that
// takes the next seq, so it never decreases along seq. Keeps the unseen scan
// to the recent window without an index on ts.
function firstSeqAtOrAfter(db, userId, ts) {
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)?.seq ?? 0
  const probe = db.prepare('SELECT seq, ts FROM events WHERE user_id=? AND seq>=? ORDER BY seq LIMIT 1')
  let lo = 0
  let hi = head + 1
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2)
    const row = probe.get(userId, mid)
    if (!row) { hi = mid; continue }
    if (row.ts >= ts) hi = mid
    else lo = row.seq + 1
  }
  return lo
}

function parsePayload(raw) {
  try { return JSON.parse(raw) } catch { return null }
}

// What the user hasn't seen. Returns { entries, truncated }, important first,
// then newest first. Options:
//   now, olderThanMs (don't raise what they're about to read), sinceMs,
//   importance 'important'|'all', convoId, missionNum, includeFlagged, limit,
//   excludePrivateOwned (the caller is an ordinary agent),
//   sender (unseen_mine: only this sender's messages, no items).
export function listUnseen(db, userId, {
  now = Date.now(), olderThanMs = 30 * 60000, sinceMs = 3 * 86400000, importance = 'important',
  convoId = null, missionNum = null, includeFlagged = false, limit = 50, excludePrivateOwned = false, sender = null,
} = {}) {
  const from = now - sinceMs
  const until = now - olderThanMs
  if (until < from) return { entries: [], truncated: false }
  let missionId = null
  if (missionNum != null) {
    missionId = db.prepare('SELECT id FROM missions WHERE user_id=? AND num=?').get(userId, missionNum)?.id
    if (!missionId) return { entries: [], truncated: false }
  }
  const lowSeq = firstSeqAtOrAfter(db, userId, from)
  const coordConvo = getCoordinatorConvoId(db, userId)

  const where = []
  const args = [userId, userId, lowSeq, until]
  if (convoId) { where.push('AND e.convo_id=?'); args.push(convoId) }
  if (missionId) { where.push('AND c.mission_id=?'); args.push(missionId) }
  if (sender) { where.push('AND e.sender=?'); args.push(sender) }
  if (excludePrivateOwned) where.push('AND (c.agent_device_id IS NULL OR c.agent_device_id NOT IN (SELECT id FROM devices WHERE private=1))')
  const rows = db.prepare(
    `SELECT e.seq, e.convo_id, e.ts, e.sender, e.type, e.payload,
            c.title, c.session_state, c.mission_id,
            EXISTS(SELECT 1 FROM convo_agents ca WHERE ca.convo_id=c.id) AS is_room
       FROM events e JOIN conversations c ON c.id=e.convo_id
      WHERE e.user_id=? AND c.owner_user_id=? AND e.seq>=? AND e.ts<=?
        AND e.type IN (${UNSEEN_TYPES_SQL}) AND e.sender NOT LIKE 'user:%'
        AND c.parent_convo_id IS NULL AND c.session_state!='archived'
        ${where.join(' ')}
        AND NOT EXISTS(SELECT 1 FROM seen_ranges s WHERE s.user_id=e.user_id AND s.convo_id=e.convo_id
                        AND s.from_seq<=e.seq AND s.to_seq>=e.seq)
      ORDER BY e.seq DESC LIMIT ${SCAN_MAX}`
  ).all(...args)
  const scanCapped = rows.length === SCAN_MAX

  // Per conversation in the window: the user's newest message (answers a
  // prompt) and the newest message from anyone else (the "final" one).
  const lastUser = new Map()
  const lastOther = new Map()
  // A prompt_reply (a button answer) is an answer; a read_marker, though
  // it carries the user's sender, is not. The "final" message ignores item
  // fallback texts and consent cards, which are never listed themselves.
  for (const r of db.prepare(
    `SELECT convo_id, MAX(CASE WHEN sender LIKE 'user:%' THEN seq END) AS u,
            MAX(CASE WHEN sender NOT LIKE 'user:%'
                      AND json_extract(payload, '$.fallback_for') IS NULL
                      AND (type!='permission_request' OR COALESCE(json_extract(payload, '$.kind'), '') NOT IN ('agent_chat','agent_spawn'))
                     THEN seq END) AS o
       FROM events WHERE user_id=? AND seq>=? AND type IN (${UNSEEN_TYPES_SQL},'prompt_reply') GROUP BY convo_id`
  ).iterate(userId, lowSeq)) {
    lastUser.set(r.convo_id, r.u ?? 0)
    lastOther.set(r.convo_id, r.o ?? 0)
  }
  const missionNums = new Map()
  const numOf = (id) => {
    if (!id) return null
    if (!missionNums.has(id)) missionNums.set(id, db.prepare('SELECT num FROM missions WHERE id=?').get(id)?.num ?? null)
    return missionNums.get(id)
  }

  const entries = []
  for (const r of rows) {
    const payload = parsePayload(r.payload)
    // Items speak for themselves (their fallback text and consent cards).
    if (payload && typeof payload === 'object' && payload.fallback_for) continue
    if (isClientOnlyEvent(r.type, payload)) continue
    // The Coordinator's own conversation is where it tells the user things;
    // raising its messages back to it is noise, except via unseen_mine.
    if (!sender && r.convo_id === coordConvo) continue
    const reasons = []
    if (r.type === 'prompt' || r.type === 'permission_request') {
      if ((lastUser.get(r.convo_id) ?? 0) > r.seq) continue // answered since
      reasons.push(r.type === 'prompt' ? 'prompt' : 'permission')
    }
    if (r.type === 'spawn_outcome' && payload?.outcome === 'failed') reasons.push('failure')
    if ((r.session_state === 'done' || r.session_state === 'waiting') && lastOther.get(r.convo_id) === r.seq) reasons.push('final')
    // An agent-to-agent room is the user's to skim, never important on its
    // own: its prompts and last messages are addressed to the other agent,
    // and whatever there needs the user becomes a tracker item (which is
    // raised as awaiting_user). Being named in a room used to count, but
    // the user's name is also a box name and in every "<name> approved…",
    // so that reason was mostly noise and was dropped (mission 5798).
    if (r.is_room) reasons.length = 0
    entries.push({
      ref: `msg:${r.convo_id}:${r.seq}`, kind: 'message',
      convo_id: r.convo_id, convo_title: r.title, session_state: r.session_state, mission_num: numOf(r.mission_id),
      is_room: !!r.is_room, seq: r.seq, ts: r.ts, sender: r.sender, type: r.type,
      snippet: r.type === 'text' ? String(payload?.body ?? '').slice(0, 280) : snippetOf(r.type, payload),
      reasons, important: reasons.length > 0,
    })
  }

  if (!sender) {
    const itemWhere = []
    const itemArgs = [userId]
    if (convoId) { itemWhere.push('AND i.origin_convo_id=?'); itemArgs.push(convoId) }
    if (missionId) { itemWhere.push('AND i.mission_id=?'); itemArgs.push(missionId) }
    if (excludePrivateOwned) itemWhere.push('AND NOT EXISTS(SELECT 1 FROM conversations oc JOIN devices d ON d.id=oc.agent_device_id WHERE oc.id=i.origin_convo_id AND d.private=1)')
    const items = db.prepare(
      `SELECT i.id, i.num, i.kind, i.title, i.awaiting, i.created_by, i.created_at, i.origin_convo_id, i.mission_id,
              (SELECT MAX(created_at) FROM item_comments ic WHERE ic.item_id=i.id AND ic.author='agent' AND ic.kind='comment') AS agent_at,
              (SELECT MAX(created_at) FROM item_comments ic WHERE ic.item_id=i.id AND ic.author='user') AS user_at,
              s.seen_through_comment_at AS seen_through, s.seen_at
         FROM items i LEFT JOIN item_seen s ON s.user_id=i.user_id AND s.item_id=i.id
        WHERE i.user_id=? AND i.state='open' AND i.consent IS NULL ${itemWhere.join(' ')}`
    ).all(...itemArgs)
    for (const it of items) {
      const createdByAgent = it.created_by === 'agent'
      const latest = Math.max(createdByAgent ? it.created_at : 0, it.agent_at ?? 0)
      if (latest === 0 || latest < from || latest > until) continue
      // Engaging with the thread (a comment, an action tap) is seeing it.
      if ((it.user_at ?? 0) >= latest) continue
      const bodyUnseen = createdByAgent && it.seen_at == null
      const commentUnseen = it.agent_at != null && it.agent_at > (it.seen_through ?? 0)
      if (!bodyUnseen && !commentUnseen) continue
      const reasons = []
      if (it.awaiting === 'user') reasons.push('awaiting_user')
      if (it.kind === 'question') reasons.push('question')
      let snippet = it.title
      if (commentUnseen) {
        const c = db.prepare("SELECT body FROM item_comments WHERE item_id=? AND author='agent' AND kind='comment' ORDER BY created_at DESC LIMIT 1").get(it.id)
        if (c?.body) snippet = `${it.title} — ${c.body}`
      }
      const convo = db.prepare('SELECT title, session_state FROM conversations WHERE id=?').get(it.origin_convo_id)
      entries.push({
        ref: `item:${it.id}:${latest}`, kind: 'item',
        convo_id: it.origin_convo_id, convo_title: convo?.title ?? '', session_state: convo?.session_state ?? null,
        mission_num: numOf(it.mission_id), is_room: false,
        item_id: it.id, item_num: it.num, item_kind: it.kind, ts: latest,
        snippet: snippet.slice(0, 280), reasons, important: reasons.length > 0,
      })
    }
  }

  let out = entries
  // 'important' also keeps agent-to-agent rooms out: those are the user's
  // to skim, not to be told about.
  if (importance === 'important') out = out.filter((e) => e.important)
  if (!includeFlagged && out.length) {
    const flagged = new Set(db.prepare('SELECT ref FROM unseen_flags WHERE user_id=?').all(userId).map((r) => r.ref))
    out = out.filter((e) => !flagged.has(e.ref))
  }
  out.sort((a, b) => (b.important - a.important) || (b.ts - a.ts))
  const cap = Math.max(1, Math.min(limit, UNSEEN_LIMIT_MAX))
  return { entries: out.slice(0, cap), truncated: out.length > cap || scanCapped }
}
