// HTTP surface of the task & decision tracker (spec: HTTP API). Validation,
// auth, and the three side effects the pure module must not know about:
// the 'item' marker event on the origin conversation, wake-on-message for
// user-authored writes, and the push pipeline.
import { appendAndBroadcast, toEventShape } from './journal.js'
import { isPrivateDevice } from './db.js'
import { authorizeAgentWrite } from './auth.js'
import { wakeConvoAgent } from './wake.js'
import { json, readBody } from './http-body.js'
import { idemKeyOf, senderOf, badRequest, notFound, conflict } from './http-who.js'
import {
  ITEM_KINDS, AWAITING, RESOLUTIONS, BODY_MAX, validateItemFields, createItem, getItem, listItems, listComments,
  updateItem, addComment, setAttachmentTranscript, closeItem, reopenItem, rerankItem,
} from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE, ITEM_ACTIONS, itemFallbackText, FALLBACK_ACTIONS } from './items-marker.js'
import { visibleMission } from './missions-http.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'

const SORTS = ['rank', 'updated']
const STATES = ['open', 'closed']
const POSITIONS = ['top', 'bottom']
const ID_MAX = 128
// The item transitions in items.js signal their one recoverable failure by
// throwing a tagged Error; each maps to exactly one of the existing error
// shapes. Anything else is a bug and must reach http.js's 500.
const ERROR_STATUS = { bad_after_before: 400, bad_supersedes: 400, idem_key_conflict: 409 }
// Wake keys off the ACTION as well as the writer: a reorder is bookkeeping,
// not something a sleeping box needs to be booted for.
const WAKE_ACTIONS = new Set(['created', 'commented', 'closed', 'reopened'])

// Answers `true` when `err` is one of the known transition failures above.
function answerKnownError(res, err) {
  const status = ERROR_STATUS[err && err.message]
  if (!status) return false
  return status === 409 ? conflict(res) : badRequest(res)
}

// Visible = owned by the caller's user and, for an ordinary agent, not born
// in a private device's conversation. Same 404 for every failure.
function visibleItem(db, who, idOrNum) {
  const item = getItem(db, who.userId, idOrNum)
  if (!item) return null
  if (filteredAgent(db, who) && privateOwnedConvo(db, item.origin_convo_id)) return null
  return item
}

// The one place an 'item' marker is written. Called AFTER the item's own
// transaction has committed — never inside it, so a broadcast can never
// advertise a write that then rolls back.
function emitMarker({ db, hub, pushPipeline, waker }, who, { item, action, comment = null, by = null }) {
  // A typo'd action would ship a marker no client knows how to render;
  // that's a programmer error, not a request error, so it throws.
  if (!ITEM_ACTIONS.includes(action)) throw new Error(`unknown item action: ${action}`)
  const author = by == null ? (who.kind === 'agent' ? 'agent' : 'user') : by
  const payload = itemMarkerPayload({ item, action, by: author, comment })
  const sender = senderOf(db, who)
  let r
  try {
    r = appendAndBroadcast(db, hub, { userId: who.userId, convoId: item.origin_convo_id, sender, type: ITEM_EVENT_TYPE, payload })
  } catch (err) {
    // The table write already committed; a marker on a since-deleted
    // conversation must not fail the request (same stance as spawns.js).
    console.error('items: marker append failed (item write already committed)', err)
    return
  }
  try {
    pushPipeline.onAppend(who.userId, toEventShape({ seq: r.seq, convo_id: item.origin_convo_id, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), who.deviceId)
  } catch (err) {
    console.error('items: push onAppend failed', err)
  }
  // Old-client fallback (spec: "Old-client fallback"): right after a
  // card-worthy marker, mirror it as a plain `text` a pre-tracker client can
  // already render. Same conversation, same sender as the marker. Its own
  // append/push failures are logged and swallowed exactly like the marker's
  // — this is a degrade path, never a reason to fail the request or the
  // marker that already landed.
  if (FALLBACK_ACTIONS.has(action)) {
    const actor = sender.slice(sender.indexOf(':') + 1)
    const text = itemFallbackText(payload, { actor, body: action === 'created' ? item.body : null })
    if (text != null) {
      const fbPayload = { body: text, fallback_for: 'item', item_id: item.id, num: item.num, action }
      try {
        const fr = appendAndBroadcast(db, hub, { userId: who.userId, convoId: item.origin_convo_id, sender, type: 'text', payload: fbPayload })
        try {
          pushPipeline.onAppend(who.userId, toEventShape({ seq: fr.seq, convo_id: item.origin_convo_id, ts: fr.ts, sender, type: 'text', payload: fbPayload }), who.deviceId)
        } catch (err) {
          console.error('items: fallback push onAppend failed', err)
        }
      } catch (err) {
        console.error('items: fallback append failed', err)
      }
    }
  }
  // Wake keys off the WRITER's device kind, not `by`: an agent filing on
  // behalf of the user is already awake. Keyed off the MARKER only — the
  // fallback text never independently wakes anything.
  if (who.kind !== 'agent' && WAKE_ACTIONS.has(action)) wakeConvoAgent({ db, hub, waker }, who.userId, item.origin_convo_id)
}

// null = absent, undefined = present but not in `list` (i.e. reject).
const oneOf = (v, list) => (v == null ? null : (list.includes(v) ? v : undefined))

function handleList(db, res, url, who) {
  const q = url.searchParams
  const kind = oneOf(q.get('kind'), ITEM_KINDS)
  const state = oneOf(q.get('state'), STATES)
  const awaiting = oneOf(q.get('awaiting'), AWAITING)
  const sort = q.has('sort') ? oneOf(q.get('sort'), SORTS) : 'rank'
  if (kind === undefined || state === undefined || awaiting === undefined || sort === undefined) return badRequest(res)
  let since = null
  if (q.has('since')) {
    since = Number(q.get('since'))
    if (!Number.isInteger(since) || since < 0) return badRequest(res)
  }
  // listItems clamps `limit` itself; the route still rejects nonsense rather
  // than silently serving a default page for `limit=abc`.
  const limit = q.has('limit') ? Number(q.get('limit')) : 100
  if (!Number.isInteger(limit) || limit < 1) return badRequest(res)
  const label = q.get('label')
  if (label != null && (!label || label.length > 40)) return badRequest(res)
  const convoId = q.get('convo')
  if (convoId != null && (!convoId || convoId.length > ID_MAX)) return badRequest(res)
  const r = listItems(db, who.userId, {
    convoId, kind, state, awaiting, label, sort, since,
    limit, cursor: q.get('cursor'), excludePrivateOwned: filteredAgent(db, who),
  })
  // An undecodable cursor is a malformed request, not an empty page.
  if (r.badCursor) return badRequest(res)
  json(res, 200, { items: r.items, next_cursor: r.next_cursor })
  return true
}

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  if (!ITEM_KINDS.includes(body.kind)) return badRequest(res)
  const v = validateItemFields(body)
  if (!v.ok) return badRequest(res)
  if (body.awaiting !== undefined && body.awaiting !== null && !AWAITING.includes(body.awaiting)) return badRequest(res)
  if (body.position !== undefined && !POSITIONS.includes(body.position)) return badRequest(res)
  // `position` is exclusive: given alongside either neighbour, the intent is
  // ambiguous. `after` and `before` may be given alone or together — together
  // means a midpoint between the two, which resolveRank already computes.
  // None is fine here — a create with no placement lands at the bottom.
  if (body.position !== undefined && (body.after !== undefined || body.before !== undefined)) return badRequest(res)
  for (const k of ['after', 'before', 'supersedes', 'convo_id']) {
    if (body[k] !== undefined && (typeof body[k] !== 'string' || !body[k] || body[k].length > ID_MAX)) return badRequest(res)
  }
  if (typeof body.convo_id !== 'string') return badRequest(res)
  // on_behalf_of:'user' lets the bridge file a task the USER asked for (the
  // queued-card "Make task" tap) as user-created: created_by and the
  // marker's `by` read 'user', so the apps show who really filed it. The
  // marker's sender stays the agent device (no wake, no self-prompt).
  if (body.on_behalf_of !== undefined && (body.on_behalf_of !== 'user' || who.kind !== 'agent')) return badRequest(res)
  const idemKey = idemKeyOf(req, who)
  if (idemKey === undefined) return badRequest(res)
  // Every body-only rule is settled above, so a malformed field answers 400
  // even when the conversation is one this caller may not see.
  //
  // The origin conversation must be the caller's user's; an AGENT must
  // additionally clear the same gate every other agent-authored append does
  // (ws.js publish/prompt/stream, /convo/:id/messages): it owns the
  // conversation or has joined it. 404, never 403 — a refusal must be
  // indistinguishable from a conversation that isn't there. Then the sieve:
  // an ordinary agent cannot file into a private-owned convo even if joined.
  const convo = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(body.convo_id)
  if (!convo || convo.owner_user_id !== who.userId) return notFound(res)
  if (who.kind === 'agent' && !authorizeAgentWrite(db, who.userId, who.deviceId, body.convo_id)) return notFound(res)
  if (filteredAgent(db, who) && convo.agent_device_id != null && isPrivateDevice(db, convo.agent_device_id)) return notFound(res)
  const createdBy = body.on_behalf_of === 'user' || who.kind !== 'agent' ? 'user' : 'agent'
  let out
  try {
    out = createItem(db, {
      userId: who.userId, kind: body.kind, ...v.value,
      awaiting: body.awaiting,
      position: body.position, after: body.after, before: body.before,
      originConvoId: body.convo_id, originDeviceId: who.deviceId,
      createdBy,
      supersedes: body.supersedes ?? null, idemKey,
    })
  } catch (err) {
    if (answerKnownError(res, err)) return true
    throw err
  }
  // A replayed idempotency key must not fan a second marker out.
  if (!out.duplicate) emitMarker(ctx, who, { item: out.item, action: 'created', by: createdBy })
  json(res, out.duplicate ? 200 : 201, { item: out.item })
  return true
}

async function handlePatch(ctx, req, res, who, item) {
  const { db } = ctx
  const body = await readBody(req)
  // Body attachments are set at create only (v1). Silently dropping them
  // told a client its blob had landed when nothing was written, so an
  // attempt is a bad request rather than a no-op field.
  if (body.attachments !== undefined) return badRequest(res)
  const v = validateItemFields(body, { partial: true })
  if (!v.ok) return badRequest(res)
  const fields = { ...v.value }
  if (body.awaiting !== undefined) {
    if (body.awaiting !== null && !AWAITING.includes(body.awaiting)) return badRequest(res)
    // A closed item awaits nobody (the close cleared it): handing the ball
    // back means reopening first, so this is a state conflict, not a bad
    // field. Clearing it (null) agrees with the closed state and is allowed.
    if (body.awaiting !== null && item.state === 'closed') return conflict(res)
    fields.awaiting = body.awaiting
  }
  // Missions (spec 2026-09-10): explicit move or detach. `mission` is a
  // mission id, "#num", a bare number, or null. Never inferred. Gated by
  // the same visibility sieve as GET /missions/:id — a mission an ordinary
  // agent can't see must not be reachable as a move target either (it would
  // both let the agent attach an item to hidden content and act as an
  // existence oracle for private missions).
  let missionTarget
  if (body.mission !== undefined) {
    if (body.mission === null) missionTarget = null
    else {
      const target = visibleMission(db, who, body.mission)
      if (!target) return notFound(res)
      missionTarget = target.id
    }
  }
  if (Object.keys(fields).length === 0 && body.mission === undefined) return badRequest(res)
  // Fields and the mission move are ONE write with ONE `updated_at` (final
  // review minor): they used to be two statements in two transactions, so a
  // `{title, mission}` patch could half-apply and stamped two timestamps.
  const result = updateItem(db, { userId: who.userId, itemId: item.id, fields, missionId: missionTarget })
  // Only reachable if the item vanished between the read and the write.
  if (!result) return notFound(res)
  // Every mutating route appends a marker, this one included: a retitle or a
  // hand-moved `awaiting` is a change connected clients must see without
  // re-polling. It is a quiet action though — no wake, no push (see
  // ITEM_ACTIONS in items-marker.js).
  emitMarker(ctx, who, { item: result, action: 'updated' })
  json(res, 200, { item: result })
  return true
}

export async function handleItemsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path !== '/items' && !path.startsWith('/items/')) return false

  if (path === '/items') {
    if (req.method === 'GET') return handleList(db, res, url, who)
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    return false
  }

  // The trailing id is nested inside the sub segment on purpose: flattened,
  // `/items/:id/<junk>` matched as [id, null, junk] and served/mutated the
  // item as if the junk weren't there.
  const m = path.match(/^\/items\/([^/]+)(?:\/(comments|close|reopen|rank)(?:\/([^/]+))?)?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const subId = m[3] || null

  // Unknown id, another user's id, and a private-owned one all answer the
  // same 404 — nothing here is an enumeration oracle.
  const item = visibleItem(db, who, idOrNum)
  if (!item) return notFound(res)

  // No origin-conversation gate here: the tracker is scoped to the USER, not
  // to a conversation, so any of the user's boxes that can already see an
  // item (visibleItem, above) may PATCH, comment on, close, reopen, or rank
  // it — the same way any agent may read anything of the user's it can see.
  // Two routes stay gated because they target a conversation rather than an
  // already-visible item: handleCreate checks the body's `convo_id` (an
  // agent must own or have joined the conversation it's filing INTO), and
  // the transcript PATCH below (handleItemSubRoute's comments/:cid branch)
  // is gated on the item's origin conversation because transcribing a
  // voice-note attachment is specifically the origin bridge's job.

  if (!sub) {
    if (req.method === 'GET') { json(res, 200, { item, comments: listComments(db, item.id) }); return true }
    if (req.method === 'PATCH') return handlePatch(ctx, req, res, who, item)
    return false
  }

  return handleItemSubRoute(ctx, req, res, who, item, sub, subId)
}

// A status/close/reopen note is optional but, when present, bounded like any
// other body the user writes.
const okNote = (v) => v === undefined || (typeof v === 'string' && v.length <= BODY_MAX)

// Every sub-route is a mutation of an already-visible item.
async function handleItemSubRoute(ctx, req, res, who, item, sub, subId) {
  const { db } = ctx
  // visibleItem (in handleItemsRoute) is the only gate every route below
  // shares. There is no on_behalf_of on a comment: the caller's own device
  // kind is the author, full stop.
  const author = who.kind === 'agent' ? 'agent' : 'user'

  if (sub === 'comments' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    const idemKey = idemKeyOf(req, who)
    if (idemKey === undefined) return badRequest(res)
    const v = validateItemFields({ body: body.body ?? '', attachments: body.attachments }, { partial: true })
    if (!v.ok) return badRequest(res)
    const text = v.value.body ?? ''
    const attachments = v.value.attachments ?? []
    // A comment with neither words nor blobs is nothing at all — it would
    // still flip `awaiting` and wake the box, so it is a bad request.
    if (!text.trim() && attachments.length === 0) return badRequest(res)
    let out
    try {
      out = addComment(db, { userId: who.userId, itemId: item.id, author, deviceId: who.deviceId, body: text, attachments, idemKey })
    } catch (err) {
      if (answerKnownError(res, err)) return true
      throw err
    }
    // Only reachable if the item vanished between the read and the write.
    if (!out) return notFound(res)
    // A replayed idempotency key must not fan a second marker out.
    if (!out.duplicate) emitMarker(ctx, who, { item: out.item, action: 'commented', comment: out.comment })
    json(res, out.duplicate ? 200 : 201, { item: out.item, comment: out.comment })
    return true
  }

  if (sub === 'comments' && subId != null && req.method === 'PATCH') {
    // Transcript write-back is the bridge's job after it transcribes a
    // voice-note attachment; a client never patches a comment. Unlike every
    // other sub-route, this one IS gated on the item's origin conversation
    // (same predicate handleCreate applies to a body's convo_id): 404, not
    // 403, so the refusal is indistinguishable from a comment that isn't
    // there — a foreign box probing for comment ids learns nothing either way.
    if (who.kind !== 'agent') { json(res, 403, { error: 'forbidden' }); return true }
    if (!authorizeAgentWrite(db, who.userId, who.deviceId, item.origin_convo_id)) return notFound(res)
    const body = await readBody(req)
    if (typeof body.blob_ref !== 'string' || !body.blob_ref) return badRequest(res)
    if (typeof body.transcript !== 'string' || body.transcript.length > BODY_MAX) return badRequest(res)
    // Unknown comment and unknown blob_ref answer the same 404.
    const c = setAttachmentTranscript(db, { userId: who.userId, itemId: item.id, commentId: subId, blobRef: body.blob_ref, transcript: body.transcript })
    if (!c) return notFound(res)
    // No marker and no wake: filling in a transcript is not new traffic,
    // it is the agent finishing a job the apps already know about.
    json(res, 200, { comment: c })
    return true
  }

  if (sub === 'close' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    if (!RESOLUTIONS.includes(body.resolution)) return badRequest(res)
    if (!okNote(body.comment)) return badRequest(res)
    const out = closeItem(db, { userId: who.userId, itemId: item.id, resolution: body.resolution, author, deviceId: who.deviceId, comment: body.comment ?? '' })
    // The item was visible a statement ago, so the only real cause is that
    // it is already closed — a state conflict, not a missing item.
    if (!out) return conflict(res)
    emitMarker(ctx, who, { item: out.item, action: 'closed', comment: out.comment })
    json(res, 200, { item: out.item, comment: out.comment })
    return true
  }

  if (sub === 'reopen' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    if (!okNote(body.comment)) return badRequest(res)
    const out = reopenItem(db, { userId: who.userId, itemId: item.id, author, deviceId: who.deviceId, comment: body.comment ?? '' })
    if (!out) return conflict(res) // already open
    emitMarker(ctx, who, { item: out.item, action: 'reopened', comment: out.comment })
    json(res, 200, { item: out.item, comment: out.comment })
    return true
  }

  if (sub === 'rank' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    // At least one destination — none is a no-op that would still cost a
    // marker. `position` is exclusive of `after`/`before`; `after` and
    // `before` may be given alone or together (together = midpoint between
    // the two, which resolveRank already computes).
    const given = ['position', 'after', 'before'].filter((k) => body[k] !== undefined)
    if (given.length === 0) return badRequest(res)
    if (body.position !== undefined && (body.after !== undefined || body.before !== undefined)) return badRequest(res)
    if (body.position !== undefined && !POSITIONS.includes(body.position)) return badRequest(res)
    for (const k of ['after', 'before']) {
      if (body[k] !== undefined && (typeof body[k] !== 'string' || !body[k] || body[k].length > ID_MAX)) return badRequest(res)
    }
    // Only open items carry a place in the list (resolveRank reads open
    // ranks only), so ranking a closed one is a state conflict.
    if (item.state === 'closed') return conflict(res)
    let out
    try {
      out = rerankItem(db, { userId: who.userId, itemId: item.id, position: body.position, after: body.after, before: body.before })
    } catch (err) {
      if (answerKnownError(res, err)) return true
      throw err
    }
    if (!out) return notFound(res)
    // Bookkeeping, not traffic: emitMarker skips the wake for 'reordered'
    // and push.js's classify() returns null for it.
    emitMarker(ctx, who, { item: out, action: 'reordered' })
    json(res, 200, { item: out })
    return true
  }

  return false
}
