// Consent asks mirrored into the task & decision tracker. The consent
// card lives in one conversation's timeline and is easy to lose; the
// Decisions list is where the user looks for things needing an answer. So
// every parked spawn ask also files a `question` item on the parent
// conversation, and the ANSWER closes it — the item is a MIRROR of the
// spawn row, never a second source of truth: answering still happens on
// the card (POST /agent-spawn/answer), and the row's state machine decides
// what the item says.
//
// The one invariant: a consent item is open exactly while its ask is
// 'awaiting_user'. An approved spawn leaves that state at the answer, long
// before its outcome (the target box may be woken first, minutes), so the
// approval itself closes the item and the outcome only adds a note. An item
// left open on an ask that is not waiting is offered to the user as a
// decision that can only fail with 409; reconcileConsentItems is the sweep
// that closes any such item, however it came about.
//
// The pure half (fields, closing text) comes first; the two side-effecting
// halves (file, close) follow and are best-effort by contract: the
// consent flow must never fail because the tracker did.
import { createItem, closeItem, addComment, TITLE_MAX } from './items.js'
import { emitMarker } from './items-http.js'
import { sanitizePeerText, PEER_NAME_CAP, plainText as plain } from './peer-text.js'

export const CONSENT_LABEL = 'consent'
// The item's own buttons: a tap on one answers the ask exactly as the card
// does (consentItemTapAnswer, consent-answer.js), so the user can decide
// from For you without finding the card.
export const CONSENT_ACTIONS = Object.freeze(['Approve', 'Decline'])
// Titles are capped at TITLE_MAX; the box name (PEER_NAME_CAP) plus the
// prefix leaves room for a short topic or the head of the task.
const TITLE_TAIL_MAX = 100

export const consentLink = (kind, id) => `matron://consent/${kind}/${id}`

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)
// Peer text lands inside markdown of the journal's own voice — the first
// place in this system where another agent's words meet a markdown
// renderer. Three defences, by position: a backtick in a code span would
// close it; markup characters in a name would bold, link or image-load
// from inside the sentence around it; and the task goes in a fence, whose
// closing marker must start a line of its own — the task is single-line
// (sanitizePeerText), so nothing in it can end the fence early. The task
// itself is never altered (it is what the user approves and the child
// runs): a task carrying backtick runs simply gets a longer fence than
// its longest run, which is the CommonMark rule for keeping it inside.
export const codeSpan = (s) => `\`${String(s).replace(/`/g, '')}\``
export const fenced = (s) => {
  const text = String(s)
  const longest = Math.max(0, ...(text.match(/`+/g) || []).map((run) => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return `${fence}\n${text}\n${fence}`
}

const AGENT_NAMES = { claude: 'Claude', codex: 'Codex' }
const fromBox = (source) => (source === 'box_default' ? ' (box default)' : '')

// The item's writable fields, from the consent card's payload (already
// sanitised at the ws boundary: single-line, capped peer text).
export function spawnConsentItemFields(card) {
  const from = plain(card.from_name)
  const target = plain(card.target_name)
  const tail = card.topic || cut(card.task, TITLE_TAIL_MAX)
  const title = cut(`Approve spawn on ${target} — ${tail}`, TITLE_MAX)
  // A model the ask named wins over the fallback; a box-default one (Fable)
  // does not. A card from before model_source carried only named models.
  const namedModel = !!card.model && card.model_source !== 'box_default'
  const fallback = !namedModel && card.fallback_reason === 'fable_limit' && !!card.fallback_model
  const lines = [
    `**${from}** asks to start a new agent session on **${target}**.`,
    '',
    `- **Box:** ${target}`,
    `- **Directory:** ${codeSpan(card.workdir)}`,
    // Agent, model and effort as they will run (src/spawn-model.js
    // predictSpawnRun): a value the ask did not name is the box's default,
    // and says so.
    ...(AGENT_NAMES[card.agent] ? [`- **Agent:** ${AGENT_NAMES[card.agent]}${fromBox(card.agent_source)}`] : []),
    // No model of its own and the box is out of Fable: the bridge will
    // start the child on the fallback, so the user approves knowing it.
    ...(fallback
      ? [`- **Model:** ${codeSpan(card.fallback_model)} — ${target} is at its Fable weekly limit, so a session that would start on Fable starts on Opus`]
      : card.model ? [`- **Model:** ${codeSpan(card.model)}${fromBox(card.model_source)}`] : []),
    ...(card.effort ? [`- **Effort:** ${codeSpan(card.effort)}${fromBox(card.effort_source)}`] : []),
    // The ask named a Claude model or effort, but the box runs Codex and no
    // agent was named: the target bridge ignores them (predictSpawnRun).
    ...(card.dropped_model ? [`- Model ${codeSpan(card.dropped_model)} is ignored: this box runs Codex`] : []),
    ...(card.dropped_effort ? [`- Effort ${codeSpan(card.dropped_effort)} is ignored: this box runs Codex`] : []),
    // "joins mission #N" (coordinator redesign §2d): the user approves the
    // child AND where it lands. The title rides the card as mission_title —
    // the mission was resolved through the asker's sieve, and this item
    // is the user's, so it may be shown; plain() strips markdown like every
    // other peer string in this body.
    ...(card.mission_num
      ? [`- **Joins mission #${Number(card.mission_num)}**${card.mission_title ? ` — ${plain(card.mission_title)}` : ''}`]
      : []),
    ...(card.link ? [`- **Chat room back to ${from}:** yes — approving also opens a room between the two sessions.`] : []),
    '',
    '**Task the new session will be given, verbatim:**',
    '',
    fenced(card.task),
    '',
    `**To answer:** tap **Approve** or **Decline** here, or on the spawn card in the conversation "${plain(card.from_convo_title)}". Unanswered, the request expires 24 h after it was made.`,
  ]
  return {
    title,
    body: lines.join('\n'),
    labels: [CONSENT_LABEL],
    links: [{ url: consentLink('spawn', card.request_id), title: `Spawn request ${card.request_id}` }],
  }
}

// How each terminal spawn outcome closes the item (approve and
// deny are the user's decision; expiry and failure are the ask lapsing).
// `author` is who the closing status row is attributed to — the user for
// the two outcomes only a tap produces, the asking agent otherwise.
// `decidedBy` (spec: 2026-09-29 coordinator consent) is {reason} when the
// Coordinator, not a tap, answered: the note says so, in the Coordinator's
// words, and is attributed to an agent (the Coordinator's device) rather
// than the user — the whole point of the audit line.
//
// 'approved' is not an outcome but the answer itself: the row has been
// claimed and the start is under way. It closes the item at once (the ask
// no longer waits on anyone); the outcome that follows is appended by
// spawnConsentFollowUp. 'started' and 'failed' still carry the whole story
// for an item the approval did not close (a row approved by a build that
// predates this, or an approval note that failed to write).
const STARTING = (targetName) => `Starting the session on ${targetName}; a box that is asleep is woken first, which can take a few minutes.`
export function spawnConsentClosing({ outcome, errorCode, roomId, modelFallback = null }, { targetName, link = false, decidedBy = null }) {
  const room = link && roomId ? ' A chat room between the two sessions was opened.' : ''
  // The bridge's start reply named a fallback model (src/spawn-model.js).
  const onModel = modelFallback ? ` on ${codeSpan(modelFallback.model)} — Fable limit reached` : ''
  if (decidedBy) {
    const why = ` — ${decidedBy.reason || 'no reason given'}`
    switch (outcome) {
      case 'approved': return { resolution: 'decided', author: 'agent', byCoordinator: true, comment: `Approved by the Coordinator${why}. ${STARTING(targetName)}` }
      case 'started': return { resolution: 'decided', author: 'agent', byCoordinator: true, comment: `Approved by the Coordinator${why}. The session started on ${targetName}${onModel}.${room}` }
      case 'declined': return { resolution: 'decided', author: 'agent', byCoordinator: true, comment: `Declined by the Coordinator${why}.` }
      case 'failed': return { resolution: 'cancelled', author: 'agent', byCoordinator: true, comment: `Approved by the Coordinator${why}, but the session could not be started (${errorCode || 'unknown'}).` }
      default: break
    }
  }
  switch (outcome) {
    case 'approved':
      return { resolution: 'decided', author: 'user', comment: `Approved. ${STARTING(targetName)}` }
    case 'started':
      return {
        resolution: 'decided', author: 'user',
        comment: `Approved — the session started on ${targetName}${onModel}.${room}`,
      }
    case 'declined':
      return { resolution: 'decided', author: 'user', comment: 'Declined.' }
    case 'expired':
      return { resolution: 'cancelled', author: 'agent', comment: 'Expired — no answer within 24 h.' }
    case 'failed':
      return {
        resolution: 'cancelled', author: 'agent',
        comment: `Approved, but the session could not be started (${errorCode || 'unknown'}).`,
      }
    case 'gone':
      // The reconcile sweep found the item open with no ask behind it (the
      // row was deleted with its device) — nothing is known but that.
      return { resolution: 'cancelled', author: 'agent', comment: 'Closed — the request is no longer waiting for an answer.' }
    default:
      // An outcome this build has never heard of must not be reported as
      // any of the above — least of all as an approval.
      return { resolution: 'cancelled', author: 'agent', comment: `Closed — ${outcome}.` }
  }
}

// What a spawn's outcome adds to an item its approval already closed: how
// the start went. Null for an outcome that says nothing new (a decline or
// an expiry closes the item itself, and one the user closed by hand first
// is left as they left it).
export function spawnConsentFollowUp({ outcome, errorCode, roomId, modelFallback = null }, { targetName, link = false }) {
  const room = link && roomId ? ' A chat room between the two sessions was opened.' : ''
  const onModel = modelFallback ? ` on ${codeSpan(modelFallback.model)} — Fable limit reached` : ''
  if (outcome === 'started') return `The session started on ${targetName}${onModel}.${room}`
  if (outcome === 'failed') return `The session could not be started (${errorCode || 'unknown'}).`
  return null
}

// The item's markers never push and never wake: the consent card already
// rang the pocket for the ask (permission_request is an attention push),
// and the asking bridge already hears the resolution its own way (a
// spawn_outcome, an invite answer frame). They are written under the
// ASKING agent's device — the same sender as the card — and carry
// `consent: 'spawn'|'chat'`, which makes them CLIENT-ONLY (isClientOnlyEvent,
// journal.js) exactly like the card: no agent hears of the item, live or
// on replay. And never with the old-client fallback text: that is a
// `text` message, and would overwrite the card's snippet and count a
// second unread for one ask.
const quietPush = { onAppend() {} }

// File the mirror of a freshly parked spawn ask. Best-effort by contract —
// the card is already journaled and the row parked, so a tracker failure
// is logged and the ask proceeds without an item (the row's item_id stays
// NULL and every outcome path tolerates that). `card` is the consent
// card's payload, already sanitised; `fromName` is the connection's name,
// the card's own sender. Returns the item, or null.
export function fileSpawnConsentItem({ db, hub }, { userId, fromDeviceId, fromName, fromConvoId, spawnId, card }) {
  try {
    const fields = spawnConsentItemFields(card)
    // Create and link as ONE transaction (createItem's own nests as a
    // savepoint): an item without its row pointer would be an open
    // question nothing ever closes. The marker stays outside, as every
    // item write keeps it (items-http.js: never advertise a write that
    // then rolls back).
    const item = db.transaction(() => {
      const { item } = createItem(db, {
        userId, kind: 'question', ...fields, actions: [...CONSENT_ACTIONS], awaiting: 'user',
        // A time-limited ask belongs at the top of the list, not under
        // everything the user has been putting off.
        position: 'top',
        originConvoId: fromConvoId, originDeviceId: fromDeviceId, createdBy: 'agent', consent: 'spawn',
        // Namespaced apart from HTTP idempotency keys, which are always
        // `<device id>:<key>` (http-who.js idemKeyOf).
        idemKey: `consent:spawn:${spawnId}`,
      })
      const linked = db.prepare('UPDATE agent_spawn_requests SET item_id=? WHERE id=? AND item_id IS NULL').run(item.id, spawnId).changes
      if (!linked) throw new Error(`spawn row ${spawnId} is gone or already has an item`)
      return item
    })()
    const who = { kind: 'agent', userId, deviceId: fromDeviceId, name: fromName }
    emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, who, { item, action: 'created', by: 'agent', fallback: false, extra: { consent: 'spawn' } })
    return item
  } catch (err) {
    console.error('consent item: filing failed (the card and the spawn row stand)', err)
    return null
  }
}

// Settle the mirror from the spawn row's progress. Called with 'approved'
// by the answer (consent-answer.js) the moment the row is claimed, and from
// emitSpawnOutcome with the terminal outcome, so every path that resolves a
// row — answer route, orchestration, both sweeps — keeps the item honest
// without knowing about it. An open item is closed with the outcome's note;
// one already closed (by the approval, normally) gets the start's result as
// a follow-up note and stays closed. `answeredByDeviceId` is the device
// whose answer resolved the row (a tapping client, or the Coordinator's
// box); absent for the sweeps. An item the user closed by hand before
// answering is left as they left it for a decline or an expiry. Never
// throws — telling the parent is the caller's one job and must not be
// blocked by the tracker, which is also why the row lookup sits INSIDE
// the try: a read failing under a sweep tick is a false here, never an
// exception ahead of the frame the caller still has to send.
export function closeSpawnConsentItem({ db, hub }, requestId, { outcome, errorCode, roomId, answeredByDeviceId = null, modelFallback = null }) {
  try {
    const row = db.prepare('SELECT * FROM agent_spawn_requests WHERE id=?').get(requestId)
    if (!row || !row.item_id) return false
    const targetName = sanitizePeerText(db.prepare('SELECT name FROM devices WHERE id=?').get(row.target_device_id)?.name, PEER_NAME_CAP)
      || `box ${row.target_device_id}`
    const decidedBy = row.answered_by === 'coordinator' ? { reason: row.answer_reason } : null
    const c = spawnConsentClosing({ outcome, errorCode, roomId, modelFallback }, { targetName, link: !!row.link, decidedBy })
    // The note's device: the tapping client for a user decision, the
    // Coordinator's box for its decision, the asking box otherwise.
    const deviceId = (c.author === 'user' || c.byCoordinator) && answeredByDeviceId != null ? answeredByDeviceId : row.from_device_id
    // No connection here to read the asking device's name from; the
    // devices row is the same source the card's sender came from. A device
    // deleted since the ask still gets its item settled — only the live
    // marker is skipped (clients see the change at their next /items).
    const name = db.prepare('SELECT name FROM devices WHERE id=?').get(row.from_device_id)?.name
    const mark = (item, action, comment, by) => {
      if (name) emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, { kind: 'agent', userId: row.user_id, deviceId: row.from_device_id, name }, { item, action, comment, by, fallback: false, extra: { consent: 'spawn' } })
      else console.error(`consent item: asking device ${row.from_device_id} is gone; item ${row.item_id} ${action} without a live marker`)
    }
    const out = closeItem(db, { userId: row.user_id, itemId: row.item_id, resolution: c.resolution, author: c.author, deviceId, comment: c.comment })
    if (out) { mark(out.item, 'closed', out.comment, c.author); return true }
    // Already closed: the start's result is the one thing still to say.
    const followUp = spawnConsentFollowUp({ outcome, errorCode, roomId, modelFallback }, { targetName, link: !!row.link })
    if (!followUp) return false
    const note = addComment(db, { userId: row.user_id, itemId: row.item_id, author: 'agent', deviceId: row.from_device_id, body: followUp })
    if (!note) return false
    mark(note.item, 'commented', note.comment, 'agent')
    return true
  } catch (err) {
    console.error('consent item: close failed (the spawn outcome stands)', err)
    return false
  }
}

// --- Agent-chat asks (agent_invite / agent_join) ---------------------------
// Same mirror for the other consent card (spec: 2026-08-07 agent chat
// consent). The row is convo_agents keyed (room, agent_device_id) — the
// device the card's own target_device_id names (the invitee, or the joiner
// itself) — so the link carries both. The item lives on the ROOM, where the
// card is; the justification is another agent's words and goes in a fence
// like a spawn's task.

export function chatConsentItemFields(card) {
  const from = plain(card.from_name)
  const to = plain(card.to_name)
  const join = card.request === 'join'
  const topic = card.topic ? ` — ${card.topic}` : ''
  const title = cut(join ? `${from} asks to join ${to}'s room` : `${from} asks to chat with ${to}${topic}`, TITLE_MAX)
  const session = (t) => (t ? ` — session "${plain(t)}"` : '')
  const lines = [
    join ? `**${from}** asks to join **${to}**'s room.` : `**${from}** asks to open a chat with **${to}**.`,
    '',
    `- **From:** ${from}${session(card.from_convo_title)}`,
    `- **To:** ${to}${session(card.to_convo_title)}`,
    ...(card.topic ? [`- **Topic:** ${plain(card.topic)}`] : []),
    '',
    `**Why, in ${from}'s words:**`,
    '',
    fenced(card.justification),
    '',
    '**To answer:** tap **Approve** or **Decline** here, or on the chat request card in the room conversation this item belongs to. Unanswered, the request expires 24 h after it was made.',
  ]
  return {
    title,
    body: lines.join('\n'),
    labels: [CONSENT_LABEL],
    links: [{ url: `${consentLink('chat', card.room_id)}/${card.target_device_id}`, title: 'Agent chat request' }],
  }
}

// How each way a parked chat row leaves 'awaiting_user' closes the item.
// 'left' is the owner dissolving the room under a parked join ask.
export function chatConsentClosing(outcome, decidedBy = null) {
  if (decidedBy) {
    const why = ` — ${decidedBy.reason || 'no reason given'}`
    if (outcome === 'approved') return { resolution: 'decided', author: 'agent', byCoordinator: true, comment: `Approved by the Coordinator${why}. The invitation is on its way.` }
    if (outcome === 'denied') return { resolution: 'decided', author: 'agent', byCoordinator: true, comment: `Declined by the Coordinator${why}.` }
  }
  switch (outcome) {
    case 'approved': return { resolution: 'decided', author: 'user', comment: 'Approved — the invitation is on its way.' }
    case 'denied': return { resolution: 'decided', author: 'user', comment: 'Declined.' }
    case 'expired': return { resolution: 'cancelled', author: 'agent', comment: 'Expired — no answer within 24 h.' }
    case 'left': return { resolution: 'cancelled', author: 'agent', comment: 'The room was closed before you answered.' }
    case 'gone': return { resolution: 'cancelled', author: 'agent', comment: 'Closed — the request is no longer waiting for an answer.' }
    default: return { resolution: 'cancelled', author: 'agent', comment: `Closed — ${outcome}.` }
  }
}

// What a chat mirror's markers say about the ask, for the apps' card (it
// sits in the same room, and the item's links are not on the marker):
// `consent_ask` is the row's key in the consent link's form
// (`<room_id>/<target_device_id>`), and the closing marker adds
// `consent_outcome` (chatConsentClosing's outcome: approved, denied,
// expired, left, gone) and `decided_by: 'coordinator'` when the Coordinator
// answered. Without them an app holding a card decided on another device,
// on another box or by the Coordinator has nothing to settle it from but the
// wording of the closing note. A hand close (items-http) carries neither,
// and does not answer the ask.
export const chatAskId = (roomId, agentDeviceId) => `${roomId}/${agentDeviceId}`
export function chatClosingExtra(roomId, agentDeviceId, outcome, closing) {
  return {
    consent: 'chat',
    consent_ask: chatAskId(roomId, agentDeviceId),
    consent_outcome: outcome,
    ...(closing.byCoordinator ? { decided_by: 'coordinator' } : {}),
  }
}

// File the mirror of a freshly parked chat ask; same best-effort contract
// as fileSpawnConsentItem. `agentDeviceId` is the row's key (the card's
// target_device_id). The idempotency key includes the row's created_at
// because a renewed row (a fresh ask after a deny or expiry) reuses the
// primary key and must get a fresh item, not the old closed one back.
export function fileChatConsentItem({ db, hub }, { userId, fromDeviceId, fromName, roomId, agentDeviceId, card }) {
  try {
    const fields = chatConsentItemFields(card)
    const item = db.transaction(() => {
      const row = db.prepare("SELECT created_at FROM convo_agents WHERE convo_id=? AND agent_device_id=? AND state='awaiting_user'").get(roomId, agentDeviceId)
      if (!row) throw new Error(`no parked row for ${roomId}/${agentDeviceId}`)
      const { item } = createItem(db, {
        userId, kind: 'question', ...fields, actions: [...CONSENT_ACTIONS], awaiting: 'user', position: 'top',
        originConvoId: roomId, originDeviceId: fromDeviceId, createdBy: 'agent', consent: 'chat',
        idemKey: `consent:chat:${roomId}:${agentDeviceId}:${row.created_at}`,
      })
      db.prepare("UPDATE convo_agents SET item_id=? WHERE convo_id=? AND agent_device_id=? AND state='awaiting_user'").run(item.id, roomId, agentDeviceId)
      return item
    })()
    const who = { kind: 'agent', userId, deviceId: fromDeviceId, name: fromName }
    emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, who, { item, action: 'created', by: 'agent', fallback: false, extra: { consent: 'chat', consent_ask: chatAskId(roomId, agentDeviceId) } })
    return item
  } catch (err) {
    console.error('consent item: chat filing failed (the card and the parked row stand)', err)
    return null
  }
}

// Close the mirror when a parked chat row leaves 'awaiting_user': the answer
// route and matron-admin (approved/denied, with the answering client device
// when there is one), the awaiting-TTL sweep (expired), an owner's dissolve
// (left). `hub` may be null (the admin CLI has none): the table is closed
// either way, only the live marker is skipped. Never throws.
export function closeChatConsentItem({ db, hub }, roomId, agentDeviceId, { outcome, answeredByDeviceId = null }) {
  try {
    const row = db.prepare(`
      SELECT ca.item_id, ca.initiator_device_id, ca.answered_by, ca.answer_reason, c.owner_user_id
      FROM convo_agents ca JOIN conversations c ON c.id = ca.convo_id
      WHERE ca.convo_id=? AND ca.agent_device_id=?`).get(roomId, agentDeviceId)
    if (!row || !row.item_id) return false
    const c = chatConsentClosing(outcome, row.answered_by === 'coordinator' ? { reason: row.answer_reason } : null)
    const deviceId = (c.author === 'user' || c.byCoordinator) && answeredByDeviceId != null ? answeredByDeviceId : row.initiator_device_id
    const out = closeItem(db, { userId: row.owner_user_id, itemId: row.item_id, resolution: c.resolution, author: c.author, deviceId, comment: c.comment })
    if (!out) return false
    if (!hub) return true
    const name = db.prepare('SELECT name FROM devices WHERE id=?').get(row.initiator_device_id)?.name
    if (name) emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, { kind: 'agent', userId: row.owner_user_id, deviceId: row.initiator_device_id, name }, { item: out.item, action: 'closed', comment: out.comment, by: c.author, fallback: false, extra: chatClosingExtra(roomId, agentDeviceId, outcome, c) })
    else console.error(`consent item: asking device ${row.initiator_device_id} is gone; item ${row.item_id} closed without a live marker`)
    return true
  } catch (err) {
    console.error('consent item: chat close failed (the ask\'s own outcome stands)', err)
    return false
  }
}

// --- Reconcile -------------------------------------------------------------
// The invariant's backstop: every open spawn or chat mirror whose ask is not
// 'awaiting_user' is closed, with the most the ask's row can still say. One
// pass at each sweep tick (ws.js), so it also runs within a tick of every
// start — which is what closes the items earlier builds left open. The ways
// an item gets here: a row approved by a build that closed only at the
// outcome; a row deleted with its device (the cascade takes the ask, not the
// item); a renewed chat row, whose item_id now names the newer ask's item;
// an item reopened before reopening a mirror was refused. Contact and share
// mirrors (sharing-events.js) are answered on the item itself and are not
// swept here. Returns how many items it closed; never throws.
const SPAWN_STATE_OUTCOME = { approved: 'approved', started: 'started', denied: 'declined', expired: 'expired', failed: 'failed' }
const CHAT_STATE_OUTCOME = { invited: 'approved', joined: 'approved', denied: 'denied' }

export function reconcileConsentItems({ db, hub }) {
  let closed = 0
  offerConsentActions(db)
  try {
    const stale = db.prepare(`
      SELECT i.id, i.user_id, i.consent, i.origin_device_id FROM items i
      WHERE i.consent IN ('spawn','chat') AND i.state='open'
        AND NOT EXISTS (SELECT 1 FROM agent_spawn_requests r WHERE r.item_id = i.id AND r.state='awaiting_user')
        AND NOT EXISTS (SELECT 1 FROM convo_agents ca WHERE ca.item_id = i.id AND ca.state='awaiting_user')`).all()
    for (const item of stale) {
      let done = false
      if (item.consent === 'spawn') {
        const row = db.prepare('SELECT id, state, room_id FROM agent_spawn_requests WHERE item_id=?').get(item.id)
        if (row) done = closeSpawnConsentItem({ db, hub }, row.id, { outcome: SPAWN_STATE_OUTCOME[row.state] ?? 'gone', roomId: row.room_id })
      } else {
        const row = db.prepare('SELECT convo_id, agent_device_id, state FROM convo_agents WHERE item_id=?').get(item.id)
        if (row) done = closeChatConsentItem({ db, hub }, row.convo_id, row.agent_device_id, { outcome: CHAT_STATE_OUTCOME[row.state] ?? 'gone' })
      }
      if (!done) done = closeOrphanConsentItem({ db, hub }, item)
      if (done) closed += 1
    }
  } catch (err) {
    console.error('consent item: reconcile failed', err)
  }
  if (closed) console.log(`consent items: closed ${closed} whose request was no longer waiting`)
  return closed
}

// Items filed before spawn and chat mirrors carried their own buttons get
// them, while their ask still waits: Approve and Decline on the item answer
// it exactly as the card does. updated_at moves so an app's next item sync
// picks the buttons up. Never throws.
export function offerConsentActions(db) {
  try {
    const n = db.prepare(`
      UPDATE items SET actions=?, updated_at=?
      WHERE consent IN ('spawn','chat') AND state='open' AND actions='[]'
        AND (EXISTS (SELECT 1 FROM agent_spawn_requests r WHERE r.item_id = items.id AND r.state='awaiting_user')
          OR EXISTS (SELECT 1 FROM convo_agents ca WHERE ca.item_id = items.id AND ca.state='awaiting_user'))`)
      .run(JSON.stringify(CONSENT_ACTIONS), Date.now()).changes
    if (n) console.log(`consent items: offered Approve/Decline on ${n} waiting item(s) filed without them`)
    return n
  } catch (err) {
    console.error('consent item: offering actions failed', err)
    return 0
  }
}

// An open mirror with no ask row behind it at all.
function closeOrphanConsentItem({ db, hub }, item) {
  try {
    const c = spawnConsentClosing({ outcome: 'gone' }, { targetName: '' })
    const out = closeItem(db, { userId: item.user_id, itemId: item.id, resolution: c.resolution, author: c.author, deviceId: item.origin_device_id, comment: c.comment })
    if (!out) return false
    const name = db.prepare('SELECT name FROM devices WHERE id=?').get(item.origin_device_id)?.name
    if (hub && name) emitMarker({ db, hub, pushPipeline: quietPush, waker: null }, { kind: 'agent', userId: item.user_id, deviceId: item.origin_device_id, name }, { item: out.item, action: 'closed', comment: out.comment, by: c.author, fallback: false, extra: { consent: item.consent, consent_outcome: 'gone' } })
    return true
  } catch (err) {
    console.error('consent item: orphan close failed', err)
    return false
  }
}
