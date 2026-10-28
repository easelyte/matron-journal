// Asks the Coordinator had another session make. The guard on the
// Coordinator's own asks (src/consent-own-ask.js) holds an ask it made from
// its own conversation to a root the journal can vouch for. Without more, a
// Coordinator steered by an injected turn could step around it: tell another
// session to make the ask — by a carry-on (session_control) or a message in
// a room they share — and then approve that ask as "another agent's", which
// has no cause check. This module keeps what the journal needs to see such a
// relay, and resolveRelayedAsk holds an ask that came out of one to exactly
// the rule the Coordinator's own asks meet.
//
// Two kinds of HOP are recorded, both written by the journal itself at the
// moment it relays or stores the thing, never on a bridge's later say-so:
//  - every carry-on the Coordinator sends (`carry_on:<id>`): who sent it, to
//    which session, and the causes of the Coordinator's turn that sent it.
//    The target bridge is handed the id (`carry_on_id`) and names it as the
//    ref of the turn's `carry_on` cause;
//  - every room message the Coordinator posts (`room:<room>@<seq>`), with the
//    causes of the turn that posted it; and every room message ANOTHER
//    session posts in a turn that a Coordinator hop reached, with the keys of
//    the Coordinator hops behind it (its ORIGINS) — so a relay several hops
//    long (the Coordinator → session A → session B) still leads back to the
//    Coordinator, however many plain messages the chain passed through.
//  - every spawn the Coordinator asked for, once it has started
//    (`spawn:<id>`): the child conversation it started and the causes of
//    the Coordinator's turn that asked for it — the child's opening turn is
//    the task the Coordinator wrote. The child's bridge names the spawn on
//    that turn (`other`, ref `spawned:<id>`, the id relayed with the start
//    RPC). A spawn asked for by a session a Coordinator hop reached is kept
//    the same way with the origins behind it, so a spawn chain still leads
//    back.
// Room messages and spawns no Coordinator hop reached are not recorded at
// all: asks born of them are answered exactly as before.
//
// An ask's origins (originsOf) are the Coordinator hops its causes reach:
// a carry-on issued to the asking conversation, the Coordinator's or a relay
// row's messages in a room the asking conversation is in, and, through a
// spawn outcome, the causes of that conversation's own earlier ask. A cause
// that claims a Coordinator hop the journal cannot check — a carry-on with no
// usable ref, or one issued to another session; a room it is not in; a room
// cause with no seq from a room the Coordinator spoke in — is UNCHECKABLE: it
// can only make the ask stricter, never let it through.
//
// Two things can hide a hop without claiming one: a walk cut short (a list
// the bridge truncated, a spawn chain past the depth limit, too many
// lookups), and a turn whose causes say nothing of where it came from (none
// at all, or only a reminder, a handoff or `other`, as when the harness
// starts a turn by itself). Neither can be told apart from an ordinary turn,
// so they count as UNCHECKABLE only for a session the Coordinator reached in
// the last 48 h (a carry-on sent to it, a relay it posted, a Coordinator hop
// in a room it is in), or when the walk had already found a hop. Every
// other session's asks are answered as before.
//
// The causes are peer data, as everywhere: a ref is only ever parsed, and
// every claim in it is looked up again, scoped to the asking user.
import { randomBytes } from 'node:crypto'
import { normalizeCauses, parseCauses, causesFromFrame } from './ask-causes.js'
import { resolveAskCause, CAUSE_CHAIN_MAX_DEPTH, FUTURE_SLACK_MS, SELF_APPROVAL_USER_WINDOW_MS } from './ask-cause.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { participantConvoIds } from './participants.js'
import { getSpawn } from './spawns.js'

// How long a hop is kept. Far past every root window (48 h): a hop older
// than that can never lead to a root that still counts, and keeping it this
// long means a late delivery still finds the record rather than reading as
// a plain message.
export const HOP_TTL_MS = 14 * 24 * 60 * 60 * 1000
// Distinct Coordinator hops one ask may trace back to before it is refused
// as unchecked rather than resolved one by one.
export const ORIGINS_MAX = 8
// Lookups in one originsOf walk.
const ORIGIN_LOOKUPS_MAX = 32
// Recorded messages one room cause's span may hold (a read of a room takes
// in up to 200 messages). Many of them are relays that lead back to the same
// Coordinator hop, so this bounds the read, not the origins (ORIGINS_MAX
// counts those).
const ROOM_SPAN_ROWS_MAX = 200
// Rooms with recent hops checked for a session's membership; past it, the
// session counts as reached.
export const TOUCHED_ROOMS_MAX = 32
// Cause kinds that say nothing of where a turn's work came from.
const LINEAGE_HIDING = new Set(['other', 'reminder', 'handoff'])
// The origin that stands for a Coordinator hop the journal cannot check.
export const UNCHECKABLE = '?'

export const WHY_RELAY_UNCHECKED = 'the ask was relayed from the Coordinator by a cause the journal cannot check'
export const whyRelayed = (key, why) => `relayed from the Coordinator (${key}): ${why}`

const CARRY_ON_REF_RE = /^carry_on:(co_[0-9a-f]{16})$/
// room:<room id>@<seq> or room:<room id>@<from>-<to>; a room id never holds
// an `@`. At most 15 digits per seq, so Number() is exact.
const ROOM_REF_RE = /^room:([^@]+)@([1-9][0-9]{0,14})(?:-([1-9][0-9]{0,14}))?$/
const BARE_ROOM_REF_RE = /^room:([^@]+)$/

export const roomHopKey = (roomId, seq) => `room:${roomId}@${seq}`

const prune = (db, now) => db.prepare('DELETE FROM cause_hops WHERE created_at < ?').run(now - HOP_TTL_MS)

const getHop = (db, userId, key) => db.prepare('SELECT * FROM cause_hops WHERE user_id=? AND key=?').get(userId, key)

// A carry-on the Coordinator is sending: recorded before the journal relays
// it, so its id can travel with it. `causes` is the Coordinator turn's list
// (normalised, or null). → the id the target bridge cites.
export function recordCarryOn(db, { userId, fromConvoId, targetConvoId, causes, now = Date.now() }) {
  const id = `co_${randomBytes(8).toString('hex')}`
  prune(db, now)
  db.prepare(`INSERT INTO cause_hops(user_id, key, from_convo_id, to_convo_id, coordinator, causes, created_at)
    VALUES(?,?,?,?,1,?,?)`).run(userId, `carry_on:${id}`, fromConvoId, targetConvoId, causes ? JSON.stringify(causes) : null, now)
  return id
}

// A message an agent published into a room, as its publish frame named it:
// the session that wrote it (`from_convo_id`, which must be a conversation of
// the publishing device's) and that session's turn causes. Recorded only
// when it is the Coordinator's, or when the Coordinator reached the turn
// that wrote it. Never throws for a bad frame: the message is already
// published, and a frame that cannot be attributed is simply not a hop.
export function recordRoomPublish(db, { userId, deviceId, roomId, seq, msg, now = Date.now() }) {
  const fromConvoId = msg.from_convo_id
  if (typeof fromConvoId !== 'string' || !fromConvoId || fromConvoId.length > 128 || fromConvoId === roomId) return false
  if (!Number.isSafeInteger(seq) || seq <= 0) return false
  const own = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(fromConvoId)
  if (!own || own.owner_user_id !== userId || own.agent_device_id !== deviceId) return false
  const frame = causesFromFrame(msg)
  const key = roomHopKey(roomId, seq)
  if (getCoordinatorConvoId(db, userId) === fromConvoId) {
    prune(db, now)
    // An unusable list is stored as none: the Coordinator's hop then
    // resolves to "no cause", which refuses every ask it leads to.
    db.prepare(`INSERT OR IGNORE INTO cause_hops(user_id, key, room_id, seq, from_convo_id, coordinator, causes, created_at)
      VALUES(?,?,?,?,?,1,?,?)`).run(userId, key, roomId, seq, fromConvoId, frame.ok && frame.causes ? JSON.stringify(frame.causes) : null, now)
    return true
  }
  // An unusable list from another session cannot be read for the
  // Coordinator, so it stands for an unchecked one.
  const origins = frame.ok ? originsOf(db, { userId, convoId: fromConvoId, causes: frame.causes, at: now }) : [UNCHECKABLE]
  if (origins.length === 0) return false
  prune(db, now)
  db.prepare(`INSERT OR IGNORE INTO cause_hops(user_id, key, room_id, seq, from_convo_id, coordinator, origins, created_at)
    VALUES(?,?,?,?,?,0,?,?)`).run(userId, key, roomId, seq, fromConvoId, JSON.stringify(origins), now)
  return true
}

export const spawnHopKey = (spawnId) => `spawn:${spawnId}`

// A spawn that has just started its child: recorded when the Coordinator
// asked for it, or when a Coordinator hop reached the turn that asked for
// it. `row` is the spawn row as stored (its causes the asking turn's), read
// before or after markStarted. Never throws: the child is already running,
// and a spawn that cannot be recorded is simply not a hop.
export function recordSpawnStart(db, { row, childConvoId, now = Date.now() }) {
  try {
    if (!row || typeof row.id !== 'string' || typeof childConvoId !== 'string' || !childConvoId) return false
    const key = spawnHopKey(row.id)
    if (getCoordinatorConvoId(db, row.user_id) === row.from_convo_id) {
      prune(db, now)
      db.prepare(`INSERT OR IGNORE INTO cause_hops(user_id, key, from_convo_id, to_convo_id, coordinator, causes, created_at)
        VALUES(?,?,?,?,1,?,?)`).run(row.user_id, key, row.from_convo_id, childConvoId, typeof row.causes === 'string' && row.causes ? row.causes : null, now)
      return true
    }
    const origins = originsOf(db, { userId: row.user_id, convoId: row.from_convo_id, causes: parseCauses(row.causes), at: row.created_at })
    if (origins.length === 0) return false
    prune(db, now)
    db.prepare(`INSERT OR IGNORE INTO cause_hops(user_id, key, from_convo_id, to_convo_id, coordinator, origins, created_at)
      VALUES(?,?,?,?,0,?,?)`).run(row.user_id, key, row.from_convo_id, childConvoId, JSON.stringify(origins), now)
    return true
  } catch (err) {
    console.error('recordSpawnStart failed', err)
    return false
  }
}

const isMember = (db, roomId, convoId) => typeof convoId === 'string' && participantConvoIds(db, roomId).includes(convoId)

// The Coordinator hops a list of causes, cited by `convoId` at `at`, leads
// back to: a deduped list of hop keys, possibly holding UNCHECKABLE; empty
// when none. `at` bounds every hop (none recorded after it may be cited).
export function originsOf(db, { userId, convoId, causes, at }) {
  const out = new Set()
  const ctx = { userId, convoId, at, state: { lookups: 0, cut: false } }
  walk(db, ctx, causes, 0, out)
  if (out.size > ORIGINS_MAX) return [UNCHECKABLE]
  if (out.size > 0) {
    // A hop was found, and the cut may have hidden another that fails.
    if (ctx.state.cut) out.add(UNCHECKABLE)
    return [...out]
  }
  if ((ctx.state.cut || hidesLineage(causes)) && touchedByCoordinator(db, ctx)) return [UNCHECKABLE]
  return []
}

function hidesLineage(causes) {
  const list = normalizeCauses(causes)
  return !list || list.every((c) => LINEAGE_HIDING.has(c.kind))
}

// Whether the Coordinator reached this conversation in the 48 h before `at`.
function touchedByCoordinator(db, { userId, convoId, at }) {
  if (typeof convoId !== 'string' || !convoId) return false
  const from = at - SELF_APPROVAL_USER_WINDOW_MS
  const to = at + FUTURE_SLACK_MS
  if (db.prepare('SELECT 1 FROM cause_hops WHERE user_id=? AND to_convo_id=? AND created_at BETWEEN ? AND ? LIMIT 1').get(userId, convoId, from, to)) return true
  if (db.prepare('SELECT 1 FROM cause_hops WHERE user_id=? AND from_convo_id=? AND coordinator=0 AND created_at BETWEEN ? AND ? LIMIT 1').get(userId, convoId, from, to)) return true
  const rooms = db.prepare('SELECT DISTINCT room_id FROM cause_hops WHERE user_id=? AND room_id IS NOT NULL AND created_at BETWEEN ? AND ? LIMIT ?')
    .all(userId, from, to, TOUCHED_ROOMS_MAX + 1)
  // More rooms than are checked: the unchecked ones may hold this session,
  // so it counts as reached, like every other bound here.
  if (rooms.length > TOUCHED_ROOMS_MAX) return true
  return rooms.some((r) => isMember(db, r.room_id, convoId))
}

function walk(db, ctx, causes, depth, out) {
  const list = normalizeCauses(causes)
  if (!list) return
  for (const cause of list) {
    if (out.has(UNCHECKABLE)) return
    if (++ctx.state.lookups > ORIGIN_LOOKUPS_MAX) { ctx.state.cut = true; return }
    switch (cause.kind) {
      case 'carry_on': carryOnOrigin(db, ctx, cause, out); break
      case 'room_message': roomOrigins(db, ctx, cause, out); break
      case 'spawn_outcome': spawnOrigins(db, ctx, cause, depth, out); break
      // A list the bridge had to cut short: the dropped causes may have
      // held a Coordinator hop. Or a spawned session's opening turn.
      case 'other':
        if (cause.ref === 'truncated') ctx.state.cut = true
        else spawnedOrigin(db, ctx, cause, out)
        break
      default: break
    }
  }
}

// Only the Coordinator sends carry-ons, so every one is a hop; it must be
// one the journal relayed to THIS conversation.
function carryOnOrigin(db, ctx, cause, out) {
  const m = typeof cause.ref === 'string' ? CARRY_ON_REF_RE.exec(cause.ref) : null
  const row = m ? getHop(db, ctx.userId, cause.ref) : null
  if (!row || row.to_convo_id !== ctx.convoId || row.created_at > ctx.at + FUTURE_SLACK_MS) { out.add(UNCHECKABLE); return }
  out.add(row.key)
}

function roomOrigins(db, ctx, cause, out) {
  const ref = typeof cause.ref === 'string' ? cause.ref : ''
  const m = ROOM_REF_RE.exec(ref)
  if (!m) {
    // No seq (a same-bridge room's direct hand-off, or a bridge that
    // predates seqs): if the Coordinator was heard in that room lately,
    // this may be it, and there is no telling which message.
    const bare = BARE_ROOM_REF_RE.exec(ref)
    if (bare && db.prepare('SELECT 1 FROM cause_hops WHERE user_id=? AND room_id=? AND created_at BETWEEN ? AND ? LIMIT 1')
      .get(ctx.userId, bare[1], ctx.at - SELF_APPROVAL_USER_WINDOW_MS, ctx.at + FUTURE_SLACK_MS)) out.add(UNCHECKABLE)
    return
  }
  const roomId = m[1]
  const from = Number(m[2])
  const to = m[3] ? Number(m[3]) : from
  if (to < from) { out.add(UNCHECKABLE); return }
  const rows = db.prepare(`SELECT key, coordinator, origins FROM cause_hops
    WHERE user_id=? AND room_id=? AND seq BETWEEN ? AND ? AND created_at <= ? ORDER BY seq LIMIT ?`)
    .all(ctx.userId, roomId, from, to, ctx.at + FUTURE_SLACK_MS, ROOM_SPAN_ROWS_MAX + 1)
  if (rows.length === 0) return
  // The messages reached this conversation only if it is in the room.
  if (rows.length > ROOM_SPAN_ROWS_MAX || !isMember(db, roomId, ctx.convoId)) { out.add(UNCHECKABLE); return }
  for (const row of rows) {
    if (row.coordinator === 1) { out.add(row.key); continue }
    let origins = null
    try { origins = JSON.parse(row.origins) } catch { origins = null }
    if (!Array.isArray(origins) || origins.length === 0) { out.add(UNCHECKABLE); continue }
    for (const k of origins) out.add(typeof k === 'string' ? k : UNCHECKABLE)
  }
}

// The opening turn of a spawned session (`spawned:<id>`): the spawn's hop,
// when one was recorded; it must be the spawn that started THIS
// conversation. No hop means no Coordinator hand in the spawn.
const SPAWNED_REF_RE = /^spawned:([A-Za-z0-9-]{1,64})$/
function spawnedOrigin(db, ctx, cause, out) {
  const m = typeof cause.ref === 'string' ? SPAWNED_REF_RE.exec(cause.ref) : null
  if (!m) return
  const row = getHop(db, ctx.userId, spawnHopKey(m[1]))
  if (!row) return
  if (row.to_convo_id !== ctx.convoId || row.created_at > ctx.at + FUTURE_SLACK_MS) { out.add(UNCHECKABLE); return }
  if (row.coordinator === 1) { out.add(row.key); return }
  let origins = null
  try { origins = JSON.parse(row.origins) } catch { origins = null }
  if (!Array.isArray(origins) || origins.length === 0) { out.add(UNCHECKABLE); return }
  for (const k of origins) out.add(typeof k === 'string' ? k : UNCHECKABLE)
}

// A spawn this conversation asked for: its own causes, a hop deeper. A spawn
// that is not this conversation's is no relay of the Coordinator's.
function spawnOrigins(db, ctx, cause, depth, out) {
  const m = typeof cause.ref === 'string' ? /^spawn:(.+)$/.exec(cause.ref) : null
  const row = m ? getSpawn(db, m[1]) : null
  if (!row || row.user_id !== ctx.userId || row.from_convo_id !== ctx.convoId) return
  if (depth + 1 > CAUSE_CHAIN_MAX_DEPTH) { ctx.state.cut = true; return }
  walk(db, ctx, parseCauses(row.causes), depth + 1, out)
}

// Whether an ask another session made was relayed from the Coordinator, and
// if so whether it stands:
//   { relayed: false }                       no Coordinator hop behind it —
//                                            answered exactly as before;
//   { relayed: true, ok: true, root }        every hop resolves (root as
//                                            resolveAskCause's; the user's
//                                            or an item's before a routine's);
//   { relayed: true, ok: false, why }        refused, for the user.
// Each Coordinator hop is resolved as an ask of the Coordinator's own would
// be, from the conversation that sent it, against the causes of the turn
// that sent it, with every window measured from THIS ask's time.
export function resolveRelayedAsk(db, { who, userId, causes, createdAt, fromConvoId }) {
  if (!Number.isSafeInteger(createdAt)) return { relayed: true, ok: false, why: 'the ask has no creation time' }
  const origins = originsOf(db, { userId, convoId: fromConvoId, causes, at: createdAt })
  if (origins.length === 0) return { relayed: false }
  if (origins.includes(UNCHECKABLE)) return { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED }
  let userRoot = null
  let routineRoot = null
  for (const key of origins) {
    const row = getHop(db, userId, key)
    if (!row || row.coordinator !== 1) return { relayed: true, ok: false, why: WHY_RELAY_UNCHECKED }
    const r = resolveAskCause(db, { who, userId, causes: parseCauses(row.causes), createdAt, fromConvoId: row.from_convo_id })
    if (!r.ok) return { relayed: true, ok: false, why: whyRelayed(key, r.why) }
    if (r.root.kind === 'routine') routineRoot ??= r.root
    else userRoot ??= r.root
  }
  return { relayed: true, ok: true, root: userRoot ?? routineRoot }
}
