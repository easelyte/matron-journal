// Where an ask came from, by the journal's own record. The bridge stamps
// every spawn and chat ask with the causes of the turn that made it
// (src/ask-causes.js); this resolves those causes to a ROOT the journal can
// vouch for itself — words the user really typed or spoke, a comment or
// tap the user left on one of their items, or a fire of one of their
// routines — so that the Coordinator's approval of an ask it made itself
// can rest on something other than its own say-so.
//
// The causes are peer data: the asking bridge wrote them. A ref is only
// ever parsed, never believed — every claim in it is looked up again, and
// every lookup is scoped to the asking user. Anything that does not check
// out fails the whole resolution with a `why` the caller hands back.
//
// The rules, in order:
//  - no causes at all fails (a bridge that predates them, or a turn that
//    had none);
//  - any cause of a kind that cannot carry the user's authority (a peer's
//    room message, a reminder, a carry-on, an alert, …) fails the ask,
//    named, whatever else the turn had;
//  - the FIRST user or item cause that resolves wins: a user input in the
//    turn makes the ask the user's. When the turn had a user or item cause
//    and none resolved, the ask fails rather than fall back on a routine;
//  - a user message or item counts only in the conversation that asked: the
//    cited message must be in it, the cited item owned by it;
//  - a routine fire is the root only when the turn had no user or item
//    cause;
//  - a room message cause whose span holds only messages the asking
//    conversation itself posted (by the journal's record of them, see
//    src/cause-hops.js) and the user's own is set aside: the Coordinator
//    reading back what it wrote took in no one else's words. Any other room
//    message fails the ask like every untrusted kind;
//  - a spawn outcome stands for the causes of the ask that spawn answered,
//    followed at most CAUSE_CHAIN_MAX_DEPTH hops. A chain that ends in a
//    user or item cause that does not resolve counts as a user failure
//    here too, so it blocks a routine root beside it just the same. An
//    untrusted kind among a cited spawn's OWN causes fails only that
//    cause, not the whole ask: that spawn was itself approved on some
//    root, and the outcome is all this turn saw of it.
//
// A routine root is canonical: its ref and time are the routine's recorded
// last fire, never the cited time, so every ask born of one fire names the
// same root (the per-fire approval count is keyed on it).
import { normalizeCauses, parseCauses } from './ask-causes.js'
import { verifySaid, parseCitation } from './said.js'
import { getSpawn } from './spawns.js'
import { getRoutine, parseEnvelope, NAME_RE } from './routines.js'
import { MESSAGE_TYPES_SQL } from './message-types.js'

// How old the user's words (or item comment) may be when the ask is made.
export const SELF_APPROVAL_USER_WINDOW_MS = 48 * 60 * 60 * 1000
// How old a routine fire may be when an ask born of it is made.
export const SELF_APPROVAL_ROUTINE_WINDOW_MS = 6 * 60 * 60 * 1000
// How far a cited fire time may sit from the routine's recorded last fire.
export const FIRE_SLACK_MS = 60 * 1000
// How far a user or item event may sit AFTER the ask (clock skew between the
// ask's row and the event's; both are journal times, so minutes at most).
export const FUTURE_SLACK_MS = 5 * 60 * 1000
// Spawn-outcome hops followed before giving up.
export const CAUSE_CHAIN_MAX_DEPTH = 4
// Total spawn lookups in one resolution: a turn may cite up to CAUSES_MAX
// spawns at every hop, so a loop of wide rows would otherwise fan out to
// thousands of lookups before the depth limit cut it off.
const CAUSE_CHAIN_MAX_HOPS = 16

const USER_KINDS = new Set(['user_message', 'item_reply', 'item_tap'])
const RESOLVABLE = new Set([...USER_KINDS, 'routine', 'spawn_outcome'])
// Only an ask the spawn actually answered has an outcome the turn could have
// seen; a refused or lapsed one carries no authority onward (a retry of what
// the user turned down is the user's to approve again).
const OUTCOME_STATES = new Set(['started', 'failed'])

// The `why` strings a caller (and its tests) can match on.
export const WHY_NO_CAUSE = 'the ask carries no turn cause (bridge too old, or the turn had none)'
export const WHY_OTHER_CONVO_MESSAGE = 'the cited message is in another conversation'
export const WHY_OTHER_CONVO_ITEM = 'the cited item belongs to another conversation'
export const WHY_CHAIN_TOO_DEEP = `the cause chain is deeper than ${CAUSE_CHAIN_MAX_DEPTH} spawns`
export const WHY_CHAIN_TOO_LONG = 'the cause chain is too long'
export const WHY_NOT_ASKING_USER = 'the caller is not the asking user'
export const whyStartedBy = (kind) => `started by ${kind}`
const fail = (why) => ({ ok: false, why })

// 2026-10-20T08:00:00.000Z → ms, or null. Strict: exactly the shape
// Date#toISOString writes, and a real instant (no Feb 30th).
const ISO_MS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
function parseIsoMs(s) {
  if (typeof s !== 'string' || !ISO_MS_RE.test(s)) return null
  const ms = Date.parse(s)
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== s) return null
  return ms
}

// The routine row's envelope as an object, or null. getRoutine reads it
// back already parsed and validated; raw column text is put through the
// same validating parse, and anything else allows nothing.
function routineEnvelope(row) {
  if (typeof row.envelope === 'string') return parseEnvelope(row.envelope)
  return row.envelope && typeof row.envelope === 'object' && !Array.isArray(row.envelope) ? row.envelope : null
}

// The user/item window: not older than 48 h before the ask, not more than a
// few minutes after it. → why, or null when inside.
function outsideUserWindow(kind, at, createdAt) {
  if (at < createdAt - SELF_APPROVAL_USER_WINDOW_MS) return `the ${kind} cause is older than 48 h`
  if (at > createdAt + FUTURE_SLACK_MS) return `the ${kind} cause is later than the ask`
  return null
}

function resolveUserMessage(db, ctx, cause) {
  const citation = parseCitation(cause.ref)
  if (!citation) return fail('the user_message cause is not a <convo>:<seq> citation')
  // Only the asking conversation's own messages: a "yes" the user said in
  // another session is not an answer to this one's question.
  if (citation.convoId !== ctx.fromConvoId) return fail(WHY_OTHER_CONVO_MESSAGE)
  const r = verifySaid(db, ctx.who, citation)
  if (r.status !== 200) return fail('the user_message cause is not a message of the user\'s')
  if (r.body?.verified !== true || !Number.isSafeInteger(r.body.ts)) {
    return fail(`the user_message cause is not the user's words (${r.body?.reason ?? 'unverified'})`)
  }
  const late = outsideUserWindow('user_message', r.body.ts, ctx.createdAt)
  if (late) return fail(late)
  return { ok: true, root: { kind: 'user', ref: `${r.body.convo_id}:${r.body.seq}`, at: r.body.ts } }
}

// At most 15 digits, so Number() is exact.
const ITEM_REF_RE = /^item:([1-9][0-9]{0,14})@(.+)$/
function resolveItem(db, ctx, cause) {
  const m = typeof cause.ref === 'string' ? ITEM_REF_RE.exec(cause.ref) : null
  const at = m ? parseIsoMs(m[2]) : null
  if (!m || at == null) return fail(`the ${cause.kind} cause is not an item:<num>@<time> ref`)
  const item = db.prepare('SELECT id, origin_convo_id FROM items WHERE user_id=? AND num=?').get(ctx.userId, Number(m[1]))
  if (!item) return fail(`the ${cause.kind} cause names no item of the user's`)
  // origin_convo_id is the item's OWNER (a handover moves it): the session
  // the user's replies and taps on it reach as turns.
  if (item.origin_convo_id !== ctx.fromConvoId) return fail(WHY_OTHER_CONVO_ITEM)
  const rows = db.prepare("SELECT meta FROM item_comments WHERE item_id=? AND user_id=? AND created_at=? AND author='user' AND kind='comment'")
    .all(item.id, ctx.userId, at)
  const match = cause.kind === 'item_tap'
    ? rows.some((r) => {
      try { return typeof JSON.parse(r.meta)?.action === 'string' } catch { return false }
    })
    : rows.length > 0
  if (!match) return fail(`the ${cause.kind} cause is not a ${cause.kind === 'item_tap' ? 'tap' : 'comment'} the user left on that item`)
  const late = outsideUserWindow(cause.kind, at, ctx.createdAt)
  if (late) return fail(late)
  return { ok: true, root: { kind: 'item', ref: cause.ref, at } }
}

const ROUTINE_REF_RE = /^routine:([^@]+)@([^@]+)$/
function resolveRoutine(db, ctx, cause) {
  const m = typeof cause.ref === 'string' ? ROUTINE_REF_RE.exec(cause.ref) : null
  const firedAt = m ? parseIsoMs(m[2]) : null
  if (!m || firedAt == null || !NAME_RE.test(m[1])) return fail('the routine cause is not a routine:<name>@<fired_at> ref')
  const name = m[1]
  const row = getRoutine(db, ctx.userId, name)
  if (!row || row.name !== name) return fail('the routine cause names no routine of the user\'s')
  if (!Number.isSafeInteger(row.last_fired_at) || Math.abs(firedAt - row.last_fired_at) > FIRE_SLACK_MS) {
    return fail('the routine cause is not that routine\'s last fire')
  }
  // The windows are measured on the recorded fire (canonical), not the
  // cited time: the slack above is only for matching the citation to it.
  if (row.last_fired_at < ctx.createdAt - SELF_APPROVAL_ROUTINE_WINDOW_MS) return fail('the routine cause fired more than 6 h before the ask')
  if (row.last_fired_at > ctx.createdAt + FUTURE_SLACK_MS) return fail('the routine cause fired after the ask')
  const firedIso = new Date(row.last_fired_at).toISOString()
  return {
    ok: true,
    root: { kind: 'routine', ref: `routine:${name}@${firedIso}`, at: row.last_fired_at, routine: { ...row, envelope: routineEnvelope(row) } },
  }
}

// room:<room id>@<seq> or room:<room id>@<from>-<to>, as the bridge writes
// it (the bare room:<room id> has no span to check).
const ROOM_SPAN_RE = /^room:([^@]+)@([1-9][0-9]{0,14})(?:-([1-9][0-9]{0,14}))?$/
// Messages one span may hold and still be checked (a read takes in at most
// 200).
const ROOM_ECHO_ROWS_MAX = 200
// The content types a Coordinator's room post can be (what the publish path
// records as a hop).
const POST_TYPES = new Set(['text', 'file', 'image'])

// Whether a room_message cause names only what the asking conversation
// posted itself (each of its messages recorded as a Coordinator hop from
// that conversation) and the user's own messages. Anything else — another
// session's or another person's content of any type (a diff or a prompt as
// much as text), a span with no messages of the user's rooms in it, one too
// long to read — is not an echo.
function isOwnRoomEcho(db, ctx, cause) {
  const m = typeof cause.ref === 'string' ? ROOM_SPAN_RE.exec(cause.ref) : null
  if (!m) return false
  const roomId = m[1]
  const from = Number(m[2])
  const to = m[3] ? Number(m[3]) : from
  if (to < from) return false
  // Every content event in the span (src/message-types.js), not only text: a
  // peer's diff or prompt is words the turn may have taken in just as its
  // text is. Metadata (read markers, convo_meta, cards) is no one's words.
  const rows = db.prepare(`SELECT seq, sender, type FROM events WHERE user_id=? AND convo_id=? AND seq BETWEEN ? AND ?
    AND type IN (${MESSAGE_TYPES_SQL}) ORDER BY seq LIMIT ?`).all(ctx.userId, roomId, from, to, ROOM_ECHO_ROWS_MAX + 1)
  if (rows.length > ROOM_ECHO_ROWS_MAX) return false
  const hop = db.prepare('SELECT coordinator, from_convo_id FROM cause_hops WHERE user_id=? AND key=?')
  let messages = 0
  for (const r of rows) {
    // A client's sender is always user:<account>, and only in the user's
    // own conversations; the journal's own notices are no one's words.
    if (r.sender === 'journal' || (typeof r.sender === 'string' && r.sender.startsWith('user:'))) {
      messages++
      continue
    }
    // Only a post can be one of the Coordinator's recorded messages.
    if (!POST_TYPES.has(r.type)) return false
    const h = hop.get(ctx.userId, `room:${roomId}@${r.seq}`)
    if (!h || h.coordinator !== 1 || h.from_convo_id !== ctx.fromConvoId) return false
    messages++
  }
  return messages > 0
}

const SPAWN_REF_RE = /^spawn:(.+)$/
function resolveSpawnOutcome(db, ctx, cause, depth) {
  if (++ctx.hops > CAUSE_CHAIN_MAX_HOPS) return { ...fail(WHY_CHAIN_TOO_LONG), abort: true }
  const m = typeof cause.ref === 'string' ? SPAWN_REF_RE.exec(cause.ref) : null
  if (!m) return fail('the spawn_outcome cause is not a spawn:<id> ref')
  const row = getSpawn(db, m[1])
  if (!row || row.user_id !== ctx.userId || row.from_convo_id !== ctx.fromConvoId) {
    return fail('the spawn_outcome cause names no spawn this conversation asked for')
  }
  if (!OUTCOME_STATES.has(row.state)) return fail(`the spawn_outcome cause names a spawn that is ${row.state}`)
  if (!(row.created_at <= ctx.createdAt)) return fail('the spawn_outcome cause names a spawn asked after this ask')
  return resolveLevel(db, ctx, parseCauses(row.causes), depth + 1)
}

function resolveOne(db, ctx, cause, depth) {
  switch (cause.kind) {
    case 'user_message': return resolveUserMessage(db, ctx, cause)
    case 'item_reply':
    case 'item_tap': return resolveItem(db, ctx, cause)
    case 'routine': return resolveRoutine(db, ctx, cause)
    case 'spawn_outcome': return resolveSpawnOutcome(db, ctx, cause, depth)
    default: return fail(whyStartedBy(cause.kind))
  }
}

function resolveLevel(db, ctx, causes, depth) {
  if (depth > CAUSE_CHAIN_MAX_DEPTH) return fail(WHY_CHAIN_TOO_DEEP)
  if (causes == null || (Array.isArray(causes) && causes.length === 0)) return fail(WHY_NO_CAUSE)
  const all = normalizeCauses(causes)
  if (!all) return fail('the ask\'s causes are not a usable list')
  const list = all.filter((c) => !(c.kind === 'room_message' && isOwnRoomEcho(db, ctx, c)))
  if (list.length === 0) return fail(whyStartedBy('room_message'))
  const other = list.find((c) => !RESOLVABLE.has(c.kind))
  if (other) return fail(whyStartedBy(other.kind))
  let firstFail = null
  let firstUserFail = null
  let routineRoot = null
  for (const cause of list) {
    const r = resolveOne(db, ctx, cause, depth)
    if (r.abort) return r
    if (r.ok) {
      if (r.root.kind !== 'routine') return r
      routineRoot ??= r
      continue
    }
    firstFail ??= r
    // r.userFail: a spawn whose chain ended in an unresolved user/item cause.
    if (USER_KINDS.has(cause.kind) || r.userFail) firstUserFail ??= r
  }
  if (firstUserFail) return { ...firstUserFail, userFail: true }
  return routineRoot ?? firstFail
}

// → { ok: true, root: { kind: 'user' | 'item' | 'routine', ref, at, routine? } }
//   | { ok: false, why }
// `who` is the caller's identity (the user's words are checked as GET /said
// checks them for it), `userId` the asking user, `createdAt` the ask's own
// time (every window is measured against it, down the whole chain),
// `fromConvoId` the conversation that made the ask.
export function resolveAskCause(db, { who, userId, causes, createdAt, fromConvoId, depth = 0 }) {
  // `who` must be the real caller identity (kind, deviceId), as the request
  // was authenticated: verifySaid's private-box rule reads it, and a
  // hand-built { userId } would skip that rule.
  if (!who || who.userId !== userId) return fail(WHY_NOT_ASKING_USER)
  if (!Number.isSafeInteger(createdAt)) return fail('the ask has no creation time')
  const ctx = { who, userId, createdAt, fromConvoId, hops: 0 }
  const r = resolveLevel(db, ctx, causes, depth)
  return r.ok ? r : fail(r.why)
}
