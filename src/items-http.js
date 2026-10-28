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
  ITEM_KINDS, NOTICE_ACTIONS, AWAITING, RESOLUTIONS, BODY_MAX, validateItemFields, createItem, getItem, listItems, listComments,
  updateItem, addComment, setAttachmentTranscript, closeItem, reopenItem, rerankItem,
  markTranscriptsPending, isAudioAttachment, isConsentMirror, hidePrivateAuthors, listSharedItems, getSharedItem, listGrantedComments, listSharedComments,
  requestTurn,
} from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE, ITEM_ACTIONS, itemFallbackText, FALLBACK_ACTIONS } from './items-marker.js'
import { visibleMission, writableConvo } from './missions-http.js'
import { handleContributedItem, handleContributorItemSub, forwardToContributor } from './contribute-http.js'
import { contributableItem } from './contribute.js'
import { filteredAgent, privateOwnedConvo } from './privacy.js'
import { handleConsentTap, isSharingMirror } from './sharing-http.js'
import { transferTapAnswer } from './transfer-consent.js'
import { consentItemTapAnswer } from './consent-answer.js'
import { handlePeopleRoomTap, isPeopleRoomMirror } from './person-rooms-http.js'
import { notifyGrantees } from './sharing-events.js'
import { inlineRefsToText, knowsInlineRefs, strayInlineRef } from './inline-refs.js'
import { presentWithdrawn } from './withdrawn-comments.js'
import { handleHandoverRoute, approvalQuestionOf, handleApprovalTap, withdrawOnClose } from './item-handover-http.js'

const SORTS = ['rank', 'updated', 'acted']
const SCOPES = ['mine', 'shared']
const STATES = ['open', 'closed']
// `done` is For you's Done view (listItems): closed, or answered and no
// longer waiting on the user. Own list only.
const LIST_STATES = [...STATES, 'done']
const POSITIONS = ['top', 'bottom']
const ID_MAX = 128
// Notice items (mission: For you) reach an app only when it says it knows
// the kind: `X-Matron-Item-Kinds: notice`. Today's apps drop a row whose kind
// they don't know, so to them a notice is presented as what agents filed
// before the kind existed — a task awaiting the user with a Seen button —
// and their Seen tap still closes it (addComment keys off the stored kind).
// Agents always see the real kind.
export const ITEM_KINDS_HEADER = 'x-matron-item-kinds'
export function knowsNoticeKind(req, who) {
  if (who.kind === 'agent') return true
  const h = req.headers?.[ITEM_KINDS_HEADER]
  return typeof h === 'string' && h.split(',').some((k) => k.trim().toLowerCase() === 'notice')
}
const presentItem = (item) => (item && item.kind === 'notice' ? { ...item, kind: 'task' } : item)
const presentText = (x) => (x && typeof x.body === 'string' && x.body.includes('attachment:') ? { ...x, body: inlineRefsToText(x.body) } : x)
function replyItems(who, res, code, body) {
  if (who.knowsNotice === false) {
    if (body.item) body = { ...body, item: presentItem(body.item) }
    if (Array.isArray(body.items)) body = { ...body, items: body.items.map(presentItem) }
  }
  if (who.knowsInline === false) {
    if (body.item) body = { ...body, item: presentText(body.item) }
    if (Array.isArray(body.items)) body = { ...body, items: body.items.map(presentText) }
    if (body.comment) body = { ...body, comment: presentText(body.comment) }
    if (Array.isArray(body.comments)) body = { ...body, comments: body.comments.map(presentText) }
  }
  json(res, code, body)
}

// The item transitions in items.js signal their one recoverable failure by
// throwing a tagged Error; each maps to exactly one of the existing error
// shapes. Anything else is a bug and must reach http.js's 500.
const ERROR_STATUS = { bad_after_before: 400, bad_supersedes: 400, idem_key_conflict: 409, unknown_action: 400, item_closed: 409 }
// The failures the item-actions contract names answer with their own code
// rather than the generic one, so an app can tell "that button is gone" (the
// agent changed the offer under it) from a malformed request.
const NAMED_ERRORS = new Set(['unknown_action'])
// Wake keys off the ACTION as well as the writer: a reorder is bookkeeping,
// not something a sleeping box needs to be booted for.
const WAKE_ACTIONS = new Set(['created', 'commented', 'closed', 'reopened'])

// Answers `true` when `err` is one of the known transition failures above.
function answerKnownError(res, err) {
  const status = ERROR_STATUS[err && err.message]
  if (!status) return false
  if (NAMED_ERRORS.has(err.message)) { json(res, status, { error: err.message }); return true }
  return status === 409 ? conflict(res) : badRequest(res)
}

// A validateItemFields failure: its own named error when it carries one
// (`invalid_actions`, `too_many_attachments` with its `max`), the generic
// 400 otherwise.
// An inline ref (src/inline-refs.js) may only place one of the same write's
// own attachments: anything else would render as bare caption text, so it is
// an agent's mistake to hear about now rather than a silent gap later.
function strayRef(res, body, attachments) {
  const ref = strayInlineRef(body, attachments)
  if (ref == null) return false
  json(res, 400, { error: 'invalid_attachment_ref', ref })
  return true
}

function badFields(res, v) {
  if (v.error) { json(res, 400, { error: v.error, ...(v.max !== undefined && { max: v.max }) }); return true }
  return badRequest(res)
}

// Visible = owned by the caller's user and, for an ordinary agent, not born
// in a private device's conversation. Same 404 for every failure.
// A consent mirror (isConsentMirror, items.js) is invisible to EVERY agent,
// private ones included — it is the user's card in item form.
function visibleItem(db, who, idOrNum) {
  const item = getItem(db, who.userId, idOrNum)
  if (!item) return null
  if (filteredAgent(db, who) && privateOwnedConvo(db, item.origin_convo_id)) return null
  if (who.kind === 'agent' && isConsentMirror(db, item.id)) return null
  return item
}

// Does a user's reply on this consent mirror belong in front of the agents
// of its conversation? Only when that conversation is the asker's own:
//   - a spawn ask's mirror lives on the parent conversation — the asker's;
//   - a chat INVITE's mirror lives on the room, which the asker owns;
//   - a chat JOIN's mirror lives on the room too, but the asker is the
//     joiner, who is not in it — parking exists to keep the ask from the
//     room's owner until the user says yes, so the reply stays client-only;
//   - contact and share mirrors are answered on the item and never reach an
//     agent;
//   - a hand-over's OWNER mirror lives in the asking agent's conversation,
//     and a reply there is how the user declines with a reason ("not yet:
//     finish X first"), so it reaches that agent — answered or not. The
//     recipient's mirror is in their People conversation and reaches no one.
// A chat row renewed since (its item_id names a newer item) no longer vouches
// for this one: client-only.
function replyReachesAsker(db, item) {
  if (item.consent === 'spawn') return true
  if (item.consent === 'handover') {
    return !!db.prepare(`SELECT 1 FROM grants g JOIN conversations c ON c.id = g.origin_convo_id
      WHERE g.owner_item_id = ? AND g.origin_convo_id = ? AND c.agent_device_id = g.origin_device_id`).get(item.id, item.origin_convo_id)
  }
  if (item.consent !== 'chat') return false
  return !!db.prepare(`
    SELECT 1 FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
    WHERE ca.item_id = ? AND ca.convo_id = ? AND ca.initiator_device_id = c.agent_device_id`).get(item.id, item.origin_convo_id)
}

// The one place an 'item' marker is written. Called AFTER the item's own
// transaction has committed — never inside it, so a broadcast can never
// advertise a write that then rolls back. Exported for the journal's own
// item writes (src/consent-items.js), which pass a synthetic `who`.
// `fallback: false` skips the old-client text below — for a marker that
// mirrors something the conversation already shows as its own message (a
// consent card, src/consent-items.js): the text would overwrite the card's
// snippet and count a second unread for one ask.
export function emitMarker({ db, hub, pushPipeline, waker }, who, { item, action, comment = null, by = null, extra = null, fallback = true }) {
  // A typo'd action would ship a marker no client knows how to render;
  // that's a programmer error, not a request error, so it throws.
  if (!ITEM_ACTIONS.includes(action)) throw new Error(`unknown item action: ${action}`)
  // A consent mirror is the user's alone, whichever route wrote to it: its
  // marker carries `consent` (client-only, isClientOnlyEvent), has no
  // fallback text, and neither pushes nor wakes. The journal's own mirror
  // writes ask for all of that themselves; this is what holds for the
  // generic routes too (a hand-close, a retitle, a reorder).
  //
  // The one exception is the user's own reply, when the mirror's
  // conversation is the asker's (replyReachesAsker). It is addressed to the
  // agent that asked — "why this box?", "use the other repo" — and replying
  // on the card is where the user is when they think of it, so it goes out
  // as an ordinary marker: the asking agent hears it as a turn and its box
  // is woken. A voice reply's transcription follow-up (`updated`,
  // for_action 'commented') goes the same way, or the bridge holding that
  // turn would never get the words. The item itself stays unreadable to
  // every agent, and the reply does not change its status (keepStatus).
  const userReply = who.kind !== 'agent'
    && (action === 'commented' || (action === 'updated' && extra?.transcription != null && extra?.for_action === 'commented'))
  const mirror = item.consent != null && !(userReply && replyReachesAsker(db, item))
  if (mirror) { extra = { ...extra, consent: item.consent }; fallback = false }
  const author = by == null ? (who.kind === 'agent' ? 'agent' : 'user') : by
  // A later marker about a withdrawn reply (a transcript landing after the
  // cancel) must not carry its words back into the log: without them the
  // marker carries no comment at all (src/withdrawn-comments.js).
  const payload = itemMarkerPayload({ item, action, by: author, comment: presentWithdrawn(comment), extra })
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
    if (!mirror) pushPipeline.onAppend(who.userId, toEventShape({ seq: r.seq, convo_id: item.origin_convo_id, ts: r.ts, sender, type: ITEM_EVENT_TYPE, payload }), who.deviceId)
  } catch (err) {
    console.error('items: push onAppend failed', err)
  }
  // Old-client fallback (spec: "Old-client fallback"): right after a
  // card-worthy marker, mirror it as a plain `text` a pre-tracker client can
  // already render. Same conversation, same sender as the marker. Its own
  // append/push failures are logged and swallowed exactly like the marker's
  // — this is a degrade path, never a reason to fail the request or the
  // marker that already landed.
  if (fallback && FALLBACK_ACTIONS.has(action)) {
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
  if (!mirror && who.kind !== 'agent' && WAKE_ACTIONS.has(action) && !extra?.seen) {
    // The same write is what an item thread shows as "queued" until the
    // agent's turn starts. `item` is the object the route answers with, and
    // it was read before this point, so it is brought up to date in place:
    // the app that just tapped sees the indicator from the reply alone.
    try {
      item.working = requestTurn(db, item.id)
    } catch (err) {
      console.error('items: turn request stamp failed', err)
    }
    wakeConvoAgent({ db, hub, waker }, who.userId, item.origin_convo_id)
  }
  // A foreign agent's comment (route-vetted: extra.agent_comment) is a turn
  // for the item's owner: the writer is an agent, so the rule above skips it.
  if (!mirror && who.kind === 'agent' && action === 'commented' && extra?.agent_comment === true) {
    wakeConvoAgent({ db, hub, waker }, who.userId, item.origin_convo_id)
  }
  // A write on an item of a mission someone has been granted: their shared
  // view follows it live (spec 2026-10-02 matron-to-matron sharing). Never
  // for a consent mirror — the grantee's reads do not show one.
  // Nor for an owner-only item (`private`): no grantee can read it, so
  // there is nothing to follow and nobody to forward to.
  if (item.mission_id && item.consent == null && !item.private) notifyGrantees({ db, hub }, item.mission_id, 'item')
  // An item a contributor filed: the owner's reply reaches the conversation
  // that filed it, as another person's turn (src/contribute-http.js).
  if (item.mission_id && item.consent == null && !item.private) forwardToContributor({ db, hub, pushPipeline, waker }, who, item, { action, comment })
}

// The journal's transcription job settled every voice note on a comment
// (src/items-transcribe.js): re-announce the comment on a quiet `updated`
// marker. Quiet on purpose — no wake (the `commented` marker already woke the
// box), no push, no fallback text — but it is what an open item view refreshes
// from, and what a bridge holding the agent's turn is waiting for. The sender
// is rebuilt as the commenting user (only a user's comment is ever queued):
// the bridge routes `user:` markers as input, and `by:'user'` keeps it honest.
export function emitTranscriptionMarker(ctx, { item, comment, failed, userId, deviceId, isItemBody = false }) {
  emitMarker(ctx, { kind: 'client', userId, deviceId }, {
    item, action: 'updated', comment, by: 'user',
    extra: { transcription: failed ? 'failed' : 'done', for_action: isItemBody ? 'created' : 'commented' },
  })
}

// null = absent, undefined = present but not in `list` (i.e. reject).
const oneOf = (v, list) => (v == null ? null : (list.includes(v) ? v : undefined))

// `kind` names one kind or several, comma-separated ("question,decision,notice"
// is a client's closed list without the tasks). null = absent, undefined =
// present but not all known kinds (i.e. reject); otherwise the kinds, once each.
function kindsOf(v) {
  if (v == null) return null
  const kinds = [...new Set(v.split(','))]
  return kinds.every((k) => ITEM_KINDS.includes(k)) ? kinds : undefined
}

function handleList(db, res, url, who) {
  const q = url.searchParams
  const kind = kindsOf(q.get('kind'))
  const state = oneOf(q.get('state'), LIST_STATES)
  const awaiting = oneOf(q.get('awaiting'), AWAITING)
  const sort = q.has('sort') ? oneOf(q.get('sort'), SORTS) : 'rank'
  if (kind === undefined || state === undefined || awaiting === undefined || sort === undefined) return badRequest(res)
  // An app that predates notices is shown them as tasks (replyItems), so
  // its kind=task filter has to find them too — on either scope.
  const kindFilter = kind && kind.includes('task') && who.knowsNotice === false && !kind.includes('notice') ? [...kind, 'notice'] : kind
  const scope = q.has('scope') ? oneOf(q.get('scope'), SCOPES) : 'mine'
  if (scope === undefined) return badRequest(res)
  if (scope === 'shared') {
    // Own-list-only filters (convo, label, sort, since) are meaningless
    // across users and are rejected rather than ignored.
    for (const k of ['convo', 'label', 'sort', 'since']) if (q.has(k)) return badRequest(res)
    if (state === 'done') return badRequest(res)
    const sharedLimit = q.has('limit') ? Number(q.get('limit')) : 100
    if (!Number.isInteger(sharedLimit) || sharedLimit < 1) return badRequest(res)
    const r = listSharedItems(db, who.userId, { kind: kindFilter, state, awaiting, limit: sharedLimit, cursor: q.get('cursor') })
    if (r.badCursor) return badRequest(res)
    replyItems(who, res, 200, { items: r.items, next_cursor: r.next_cursor })
    return true
  }
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
    convoId, kind: kindFilter, state, awaiting, label, sort, since,
    limit, cursor: q.get('cursor'), excludePrivateOwned: filteredAgent(db, who), excludeConsent: who.kind === 'agent',
  })
  // An undecodable cursor is a malformed request, not an empty page.
  if (r.badCursor) return badRequest(res)
  replyItems(who, res, 200, { items: r.items, next_cursor: r.next_cursor })
  return true
}

// On a notice an agent may leave `actions` out, or name the built-in list
// itself; anything else would silently not be what it asked for.
const sameAsNoticeActions = (list) => list.length === NOTICE_ACTIONS.length && list.every((a, i) => a.toLowerCase() === NOTICE_ACTIONS[i].toLowerCase())
const noticeActionsOk = (list) => list === undefined || list.length === 0 || sameAsNoticeActions(list)

async function handleCreate(ctx, req, res, who) {
  const { db } = ctx
  const body = await readBody(req)
  // `mission`: an item filed into another person's mission the caller
  // contributes to (src/contribute-http.js). One's own items follow their
  // conversation and never name a mission.
  // `private`: an owner-only item (db.js) — what a bridge files for the
  // user alone (a secure-input request, a foreign "Allow once" ask). Set at
  // create only, and never on an item filed into someone else's mission.
  if (body.private !== undefined && typeof body.private !== 'boolean') return badRequest(res)
  if (body.mission !== undefined) {
    if (body.private !== undefined) return badRequest(res)
    return handleContributedItem(ctx, res, who, body, { writableConvo })
  }
  if (!ITEM_KINDS.includes(body.kind)) return badRequest(res)
  const v = validateItemFields(body)
  if (!v.ok) return badFields(res, v)
  if (strayRef(res, v.value.body, v.value.attachments)) return true
  if (body.kind === 'notice' && !noticeActionsOk(v.value.actions)) return badFields(res, { error: 'invalid_actions' })
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
  // Voice notes on the item BODY get the same treatment as a comment's (see
  // the comments route below): a user's are transcribed here, announced
  // pending, and the `created` turn waits for the words. Keyed off the WRITER,
  // like the wake: an agent filing on the user's behalf has no audio to send.
  const bodyAudio = [...new Set((v.value.attachments ?? []).filter(isAudioAttachment).map((a) => a.blob_ref))]
  const transcribeHere = who.kind !== 'agent' && bodyAudio.length > 0
    && !!ctx.itemTranscription?.enabled && ctx.itemTranscription.admit(who.userId, bodyAudio.length)
  if (transcribeHere) v.value.attachments = markTranscriptsPending(v.value.attachments)
  let out
  try {
    out = createItem(db, {
      userId: who.userId, kind: body.kind, ...v.value,
      awaiting: body.awaiting,
      position: body.position, after: body.after, before: body.before,
      originConvoId: body.convo_id, originDeviceId: who.deviceId,
      createdBy,
      supersedes: body.supersedes ?? null, idemKey, isPrivate: body.private === true,
    })
  } catch (err) {
    if (answerKnownError(res, err)) return true
    throw err
  }
  // A replayed idempotency key must not fan a second marker out.
  if (!out.duplicate) {
    // The body's attachments ride on the `created` marker only when there is
    // a transcript to wait for — it is where a bridge reads `pending` from.
    emitMarker(ctx, who, { item: out.item, action: 'created', by: createdBy, comment: transcribeHere ? out.bodyComment : null })
    if (transcribeHere && out.bodyComment) {
      for (const blobRef of bodyAudio) ctx.itemTranscription.enqueue({ commentId: out.bodyComment.id, userId: who.userId, blobRef })
    }
  }
  replyItems(who, res, out.duplicate ? 200 : 201, { item: out.item })
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
  if (!v.ok) return badFields(res, v)
  // A body edit can place only the attachments the body already has.
  if (v.value.body !== undefined && strayRef(res, v.value.body, item.attachments)) return true
  // A notice's one button is built in (createItem); it cannot be swapped.
  if (item.kind === 'notice' && !noticeActionsOk(v.value.actions)) return badFields(res, { error: 'invalid_actions' })
  const fields = { ...v.value }
  // Whatever an allowed list said, a notice keeps its built-in one as stored;
  // a patch of nothing else changes nothing.
  if (item.kind === 'notice' && 'actions' in fields) {
    delete fields.actions
    if (Object.keys(fields).length === 0 && body.awaiting === undefined && body.mission === undefined) {
      replyItems(who, res, 200, { item })
      return true
    }
  }
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
  replyItems(who, res, 200, { item: result })
  return true
}

export async function handleItemsRoute(ctx, req, res, url, who) {
  const { db } = ctx
  const path = url.pathname
  if (path !== '/items' && !path.startsWith('/items/')) return false
  who = { ...who, knowsNotice: knowsNoticeKind(req, who), knowsInline: knowsInlineRefs(req, who) }

  if (path === '/items') {
    if (req.method === 'GET') return handleList(db, res, url, who)
    if (req.method === 'POST') return handleCreate(ctx, req, res, who)
    return false
  }

  // The trailing id is nested inside the sub segment on purpose: flattened,
  // `/items/:id/<junk>` matched as [id, null, junk] and served/mutated the
  // item as if the junk weren't there.
  const m = path.match(/^\/items\/([^/]+)(?:\/(comments|close|reopen|rank|handover)(?:\/([^/]+))?)?$/)
  if (!m) return false
  let idOrNum
  try { idOrNum = decodeURIComponent(m[1]) } catch { return badRequest(res) }
  const sub = m[2] || null
  const subId = m[3] || null

  // Unknown id, another user's id, and a private-owned one all answer the
  // same 404 — nothing here is an enumeration oracle.
  const item = visibleItem(db, who, idOrNum)
  if (!item) {
    // Not mine: maybe a colleague's, readable under the shared rule. Read
    // only — every other method on a shared row is 403 (visible, not
    // yours), which is safe to distinguish from 404 because the caller can
    // already read it.
    const shared = getSharedItem(db, who.userId, idOrNum)
    if (!shared) return notFound(res)
    if (!sub && req.method === 'GET') {
      replyItems(who, res, 200, { item: shared, comments: shared.shared_via === 'grant' ? listGrantedComments(db, shared.id) : listSharedComments(db, shared.id) })
      return true
    }
    // A contributor to the item's mission may comment, close and reopen
    // (src/contribute-http.js answers everything else 403 too) — whichever
    // rule the read came back under: an item also visible through the org
    // rule is still on a mission they contribute to.
    if (sub && contributableItem(db, who.userId, shared.id)) return handleContributorItemSub(ctx, req, res, who, shared, sub, subId)
    json(res, 403, { error: 'forbidden' })
    return true
  }

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
    if (req.method === 'GET') {
      let comments = listComments(db, item.id)
      if (filteredAgent(db, who)) comments = hidePrivateAuthors(db, comments)
      // A reply the user withdrew before it reached the agent: every agent
      // reads that it was there, never what it said (src/withdrawn-comments.js).
      if (who.kind === 'agent') comments = comments.map(presentWithdrawn)
      replyItems(who, res, 200, { item, comments })
      return true
    }
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
  if (sub === 'handover') return handleHandoverRoute(ctx, req, res, who, item, subId)
  // visibleItem (in handleItemsRoute) is the only gate every route below
  // shares. There is no on_behalf_of on a comment: the caller's own device
  // kind is the author, full stop.
  const author = who.kind === 'agent' ? 'agent' : 'user'
  // `as_convo_id` (the handover routes' field): the conversation an agent's
  // session writes from, stored on the comment so a thread several sessions
  // post in says who wrote what. A box hosts many sessions under one token,
  // so the device alone cannot tell them apart. It labels, it does not
  // authorise: one the caller could not write to is dropped, and the comment
  // is stored without it rather than refused. undefined = malformed.
  const asConvo = (body) => {
    const v = body.as_convo_id
    if (who.kind !== 'agent' || v == null) return null
    if (typeof v !== 'string' || !v || v.length > 128) return undefined
    return authorizeAgentWrite(db, who.userId, who.deviceId, v) ? v : null
  }

  // Every comment an ordinary agent is handed back goes through the same
  // author sieve as the thread it reads (GET /items/:id).
  const seenBy = (c) => (c && filteredAgent(db, who) ? hidePrivateAuthors(db, [c])[0] : c)

  if (sub === 'comments' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    const convoId = asConvo(body)
    if (convoId === undefined) return badRequest(res)
    const idemKey = idemKeyOf(req, who)
    if (idemKey === undefined) return badRequest(res)
    // Action tap (2026-09-24 item-actions contract): `action` is the label of
    // one of the item's action buttons. Only the USER taps a button — an
    // agent answering its own question would forge the user's choice — so an
    // agent sending the field is refused outright. null is "no action". The
    // label is matched exactly (after trim) against the item's CURRENT
    // actions inside addComment's transaction (unknown_action otherwise);
    // everything else is the ordinary user-comment path.
    let action = null
    if (body.action != null) {
      if (who.kind === 'agent') { json(res, 403, { error: 'forbidden' }); return true }
      if (typeof body.action !== 'string' || !body.action.trim()) { json(res, 400, { error: 'unknown_action' }); return true }
      action = body.action.trim()
      // A contact or share card's mirror (sharing-events.js): the tap is the
      // answer to the card, applied by the journal itself — never a comment
      // for an agent to read.
      if (isSharingMirror(item)) return handleConsentTap(ctx, res, who, item, action, body.reply_to ?? null)
      // A file transfer's card, or a spawn or chat ask's mirror: the tap is
      // the answer, through the same path as the card (transfer-consent.js,
      // consent-answer.js).
      if (item.consent === 'transfer' || item.consent === 'spawn' || item.consent === 'chat') {
        if (body.reply_to != null) { json(res, 400, { error: 'unknown_action' }); return true }
        const r = item.consent === 'transfer' ? transferTapAnswer(ctx, who, item, action) : consentItemTapAnswer(ctx, who, item, action)
        if (r.status !== 200) { json(res, r.status, r.body); return true }
        json(res, 200, { item: getItem(db, who.userId, item.id) ?? item, ...r.body })
        return true
      }
      if (isPeopleRoomMirror(item)) return handlePeopleRoomTap(ctx, res, who, item, action, body.reply_to ?? null)
    }
    // `reply_to` (2026-10-04 comment-actions contract): the id of the comment
    // whose button was tapped — a follow-up question in this thread. It only
    // means anything alongside `action`; without it the tap answers the
    // item's own buttons, as every client before the contract sends it.
    let replyTo = null
    if (body.reply_to != null) {
      if (action == null || typeof body.reply_to !== 'string' || !body.reply_to) { json(res, 400, { error: 'unknown_action' }); return true }
      replyTo = body.reply_to
      // The journal's own "Hand this item over?" question (item handover):
      // its tap is the journal's to act on, not a turn for the owner.
      const handoverId = approvalQuestionOf(db, item.id, replyTo)
      if (handoverId) return handleApprovalTap(ctx, res, who, item, { handoverId, action, replyTo, idemKey })
    }
    // `actions` on a comment is the other half: the buttons an AGENT offers
    // with a follow-up question. A client offering buttons to its own user
    // makes no sense, and would move `awaiting` back onto them, so it is
    // refused like an agent's `action` is. `[]` is "none", same as absent.
    const offers = body.actions != null && !(Array.isArray(body.actions) && body.actions.length === 0)
    if (offers && who.kind !== 'agent') { json(res, 403, { error: 'forbidden' }); return true }
    const v = validateItemFields({ body: body.body ?? '', attachments: body.attachments, actions: body.actions ?? undefined }, { partial: true })
    if (!v.ok) return badFields(res, v)
    if (strayRef(res, v.value.body, v.value.attachments)) return true
    // An empty body on a tap reads as the label: an old client, the fallback
    // text and the agent's turn all see exactly what the user chose.
    const text = action != null && !(v.value.body ?? '').trim() ? action : (v.value.body ?? '')
    // A user's voice note is transcribed here, on upload, when this journal
    // has whisper (ctx.itemTranscription.enabled): stored and announced as
    // pending so the origin bridge holds the turn for the words instead of
    // transcribing the same audio itself. An agent's comment is never a turn,
    // so nothing waits on it and it is left alone.
    // admit() bounds the backlog: a comment it refuses is stored as if this
    // journal had no whisper, and the bridge transcribes it instead.
    const rawAttachments = v.value.attachments ?? []
    const audioBlobs = [...new Set(rawAttachments.filter(isAudioAttachment).map((a) => a.blob_ref))]
    const transcribeHere = who.kind !== 'agent' && audioBlobs.length > 0
      && !!ctx.itemTranscription?.enabled && ctx.itemTranscription.admit(who.userId, audioBlobs.length)
    const attachments = transcribeHere ? markTranscriptsPending(rawAttachments) : rawAttachments
    // A comment with neither words nor blobs is nothing at all — it would
    // still flip `awaiting` and wake the box, so it is a bad request.
    if (!text.trim() && attachments.length === 0) return badRequest(res)
    let out
    let ownerNotice = null // true = owner notified, string = why not, null = not applicable
    try {
      // A consent mirror follows its ask, never a comment: left to the
      // generic rule, a reply on one would reopen it (or take it out of the
      // user's Decisions list while the ask still waits) with no agent able
      // to see the item, let alone close it again.
      out = addComment(db, { userId: who.userId, itemId: item.id, author, deviceId: who.deviceId, convoId, body: text, attachments, action, replyTo, actions: v.value.actions ?? [], idemKey, keepStatus: item.consent != null })
    } catch (err) {
      if (answerKnownError(res, err)) return true
      throw err
    }
    // Only reachable if the item vanished between the read and the write.
    if (!out) return notFound(res)
    // A replayed idempotency key must not fan a second marker out.
    if (out.seen && !out.duplicate) {
      // A notice's Seen tap closed it (addComment): one quiet `closed`
      // marker so every app drops it from For you. `seen` tells a bridge it
      // is not a turn; no fallback text and no wake — nobody needs telling.
      // A pending handover offer goes with the close, before the marker and
      // the reply are built, so neither shows an offer on a closed item.
      out.item = withdrawOnClose(ctx, who.userId, item.id) ?? out.item
      emitMarker(ctx, who, { item: out.item, action: 'closed', comment: out.status, extra: { seen: true }, fallback: false })
    } else if (!out.duplicate) {
      // Another conversation's agent commenting on this item: tell the owner
      // (marker flag + wake) unless throttled, and say so in the reply.
      let extra = null
      if (who.kind === 'agent' && item.consent == null && convoId !== item.origin_convo_id) {
        let reason = null
        if (!convoId) reason = 'commenter conversation unknown (as_convo_id not sent)'
        else if (!db.prepare('SELECT 1 FROM conversations WHERE id=? AND owner_user_id=?').get(item.origin_convo_id, who.userId)) reason = 'owner conversation unavailable'
        else if (!ctx.agentCommentLimiter.take(item.id, convoId)) reason = 'rate-limited'
        if (reason) {
          ownerNotice = `The owner session will not be notified of this comment: ${reason}`
        } else {
          const row = db.prepare('SELECT title FROM conversations WHERE id=?').get(convoId)
          const label = (row?.title ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim().slice(0, 120) || senderOf(db, who).replace(/^agent:/, '')
          extra = { agent_comment: true, from_convo_id: convoId, from_label: label }
          ownerNotice = true
        }
      }
      emitMarker(ctx, who, { item: out.item, action: 'commented', comment: out.comment, extra })
      // Queued AFTER the marker so the follow-up can never precede it.
      if (transcribeHere) {
        // One job per blob: the same audio attached twice is one whisper run.
        for (const blobRef of audioBlobs) ctx.itemTranscription.enqueue({ commentId: out.comment.id, userId: who.userId, blobRef })
      }
    }
    const reply = { item: out.item, comment: seenBy(out.comment) }
    if (ownerNotice === true) reply.owner_notified = true
    else if (ownerNotice != null) { reply.owner_notified = false; reply.owner_notice = ownerNotice }
    replyItems(who, res, out.duplicate ? 200 : 201, reply)
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
    // A QUIET marker, and no wake: filling in a transcript is not new traffic
    // (no push, no fallback text, nothing a bridge turns into a turn — the
    // sender is the agent), but without it an open item view never learned
    // the words had arrived and showed a bare voice note until its next
    // refetch. Same `updated` + `transcription` shape the journal's own job
    // announces with (emitTranscriptionMarker) — including `for_action`: the
    // item body's synthetic comment belongs to the `created` turn.
    emitMarker(ctx, who, { item: getItem(db, who.userId, item.id) ?? item, action: 'updated', comment: c, extra: { transcription: 'done', for_action: c.meta?.role === 'body' ? 'created' : 'commented' } })
    json(res, 200, { comment: presentWithdrawn(seenBy(c)) })
    return true
  }

  if (sub === 'close' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    if (!RESOLUTIONS.includes(body.resolution)) return badRequest(res)
    if (!okNote(body.comment)) return badRequest(res)
    if (strayRef(res, body.comment, [])) return true
    const convoId = asConvo(body)
    if (convoId === undefined) return badRequest(res)
    const out = closeItem(db, { userId: who.userId, itemId: item.id, resolution: body.resolution, author, deviceId: who.deviceId, convoId, comment: body.comment ?? '' })
    // The item was visible a statement ago, so the only real cause is that
    // it is already closed — a state conflict, not a missing item.
    if (!out) return conflict(res)
    // As for a notice's Seen close above: the offer goes first.
    out.item = withdrawOnClose(ctx, who.userId, item.id) ?? out.item
    emitMarker(ctx, who, { item: out.item, action: 'closed', comment: out.comment })
    replyItems(who, res, 200, { item: out.item, comment: seenBy(out.comment) })
    return true
  }

  if (sub === 'reopen' && subId == null && req.method === 'POST') {
    const body = await readBody(req)
    if (!okNote(body.comment)) return badRequest(res)
    if (strayRef(res, body.comment, [])) return true
    // A consent mirror is open exactly while its ask waits for an answer;
    // reopening one would offer the user a decision that can only fail.
    if (item.consent != null) return conflict(res)
    const convoId = asConvo(body)
    if (convoId === undefined) return badRequest(res)
    const out = reopenItem(db, { userId: who.userId, itemId: item.id, author, deviceId: who.deviceId, convoId, comment: body.comment ?? '' })
    if (!out) return conflict(res) // already open
    emitMarker(ctx, who, { item: out.item, action: 'reopened', comment: out.comment })
    replyItems(who, res, 200, { item: out.item, comment: seenBy(out.comment) })
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
    replyItems(who, res, 200, { item: out })
    return true
  }

  return false
}
