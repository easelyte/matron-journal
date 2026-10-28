// A session on a handed-over mission (docs/protocol.md "Hand-over"): the
// recipient's accept can also start a new session on one of their boxes,
// with the copy as its mission and the brief as its first reading. It is
// the journal-started "New session" spawn a talk request uses
// (src/talk-requests-events.js startTalkSession), under the same rules:
//   - the recipient's own tap — the accept — is the consent: no spawn card,
//     and no agent (their Coordinator included) can ask for one;
//   - the button starts it on the box that runs their Coordinator, when
//     that box is one of their own non-private agent boxes; "Pick a box"
//     offers their non-private boxes only. A private box is used only when
//     the recipient names it themselves (POST /grants/:id/answer
//     {start_session:{device_id}}).
//   - the spawn `start` RPC with no model and agent 'claude'; with no folder
//     named it starts in the box's default directory (`workdir: ''` with
//     `talk: true`, the one flag a bridge starts an empty folder on).
// A session that cannot start never undoes the accept: the copy is made,
// and the answer (or a line on the card) says why.
import { appendAndBroadcast, upsertConversation, fanRetitled, CONVO_ID_MAX_CHARS } from './journal.js'
import { addComment } from './items.js'
import { itemMarkerPayload, ITEM_EVENT_TYPE } from './items-marker.js'
import { getMission, joinMission } from './missions.js'
import { MISSION_EVENT_TYPE, missionMarkerPayload } from './missions-marker.js'
import { markerTitleAllowed } from './privacy.js'
import { sanitizePeerText, plainText as plain } from './peer-text.js'
import { wakeIfOffline } from './wake.js'
import { coordinatorTarget, PICK_MAX, LABEL_MAX } from './talk-requests.js'

export const HANDOVER_CHOICE = { accept: 'Accept', new: 'New session', pick: 'Pick a box', decline: 'Decline' }
const JOURNAL = 'journal'
const safely = (what, fn) => { try { return fn() } catch (err) { console.error(`hand-over session: ${what} failed (the hand-over stands)`, err); return null } }
const deviceName = (db, id) => db.prepare('SELECT name FROM devices WHERE id=?').get(id)?.name ?? 'a box'

// The recipient's boxes "Pick a box" offers, most recently seen first:
// their own agent devices, never a private one. label -> device id; labels
// are the box names, trimmed and made unique, never one of the fixed
// choices.
export function pickableBoxes(db, userId, limit = PICK_MAX) {
  const rows = db.prepare(`SELECT id, name FROM devices WHERE user_id=? AND kind='agent' AND private=0
    ORDER BY (last_seen_at IS NULL), last_seen_at DESC, id DESC LIMIT ?`).all(userId, limit)
  const taken = new Set(Object.values(HANDOVER_CHOICE))
  const out = {}
  for (const r of rows) {
    const base = String(r.name ?? '').replace(/\s+/g, ' ').trim() || 'Unnamed box'
    let label = base.length > LABEL_MAX ? `${base.slice(0, LABEL_MAX - 1)}…` : base
    for (let n = 2; taken.has(label); n++) label = `${base.slice(0, LABEL_MAX - 5)} (${n})`
    taken.add(label)
    out[label] = r.id
  }
  return out
}

// The recipient's buttons, in order, each only when available.
export function handoverChoices(db, userId) {
  return [
    HANDOVER_CHOICE.accept,
    ...(coordinatorTarget(db, userId) ? [HANDOVER_CHOICE.new] : []),
    ...(Object.keys(pickableBoxes(db, userId, 1)).length ? [HANDOVER_CHOICE.pick] : []),
    HANDOVER_CHOICE.decline,
  ]
}

// Where a session would start, from what the recipient chose: 'coordinator'
// (the button) or {device_id, workdir?} (a box they named). {deviceId,
// workdir} or {refused: reason}.
export function startTarget(db, userId, request) {
  if (request === 'coordinator') {
    const t = coordinatorTarget(db, userId)
    return t ? { deviceId: t.deviceId, workdir: null } : { refused: 'no_coordinator' }
  }
  const d = db.prepare("SELECT id FROM devices WHERE id=? AND user_id=? AND kind='agent'").get(request.device_id, userId)
  if (!d) return { refused: 'not_your_box' }
  return { deviceId: d.id, workdir: request.workdir ?? null }
}

// The new session's first-turn task.
export function handoverTask(g, copy) {
  const what = g.subject_kind === 'project'
    ? `the project "${plain(sanitizePeerText(g.project_title, 120))}", handed over by ${plain(g.owner_name)}, another person; this session starts on its mission #${copy.num} ${plain(sanitizePeerText(copy.title, 120))}`
    : `mission #${copy.num} ${plain(sanitizePeerText(copy.title, 120))}, handed over by ${plain(g.owner_name)}, another person`
  return `This session was started to carry on ${what}. First read the hand-over brief: it is the mission's first milestone ("Handed over by ${plain(g.owner_name)}"; mission_get #${copy.num}). Then carry on from where it stands.`
}

// A line on the recipient's card thread, as the journal: a question with
// buttons (`actions`) or a plain note.
export function cardLine(ctx, { userId, itemId, body, actions = [] }) {
  const { db, hub } = ctx
  return safely('card line', () => {
    const out = addComment(db, { userId, itemId, author: 'agent', deviceId: 0, body, actions, keepStatus: true })
    if (!out) return null
    appendAndBroadcast(db, hub, {
      userId, convoId: out.item.origin_convo_id, sender: JOURNAL, type: ITEM_EVENT_TYPE,
      payload: itemMarkerPayload({ item: out.item, action: 'commented', by: 'agent', comment: out.comment, extra: { consent: 'handover' } }),
    })
    return out
  })
}

// After an accepted hand-over (`h`, applyHandover's result) whose accept
// asked for a session: the answer's `start_session`, at once —
// {status:'starting', device_id} | {status:'refused'|'unavailable', reason}
// — and, when starting, the start itself in the background. `itemId` is the
// recipient's card, which says how it went.
export function beginHandoverSession(ctx, { g, h, request, itemId }) {
  const { db } = ctx
  const userId = g.grantee_user_id
  const target = startTarget(db, userId, request)
  if (target.refused) return { status: 'refused', reason: target.refused }
  if (!ctx.broker) return { status: 'unavailable', reason: 'no_spawner' }
  const copy = h.copies[0]
  startHandoverSession(ctx, { g, copy, target, itemId })
    .catch((err) => console.error('hand-over session: start orchestration failed', err))
  return { status: 'starting', device_id: target.deviceId }
}

async function startHandoverSession(ctx, { g, copy, target, itemId }) {
  const { db, hub, broker, spawnStartTimeoutMs = 30000, spawnWakeWaitMs = 0 } = ctx
  const userId = g.grantee_user_id
  const box = sanitizePeerText(deviceName(db, target.deviceId), 80)
  let code = null
  let convoId = null
  try {
    if (spawnWakeWaitMs > 0) {
      let waking = false
      try { waking = wakeIfOffline(ctx, userId, target.deviceId) === true } catch (err) { console.error('hand-over session: wake threw', err) }
      if (waking) await hub.waitForDevice(userId, target.deviceId, spawnWakeWaitMs)
    }
    const params = {
      workdir: target.workdir ?? '', ...(target.workdir ? {} : { talk: true }),
      prompt: handoverTask(g, copy), agent: 'claude', mission_num: copy.num,
    }
    const r = await broker.issue(hub, userId, target.deviceId, 'start', params, { timeoutMs: spawnStartTimeoutMs })
    const id = r.ok ? r.result?.convo_id : null
    if (typeof id === 'string' && id && id.length <= CONVO_ID_MAX_CHARS && sanitizePeerText(id, CONVO_ID_MAX_CHARS) === id) convoId = id
    else code = r.ok ? 'bad_start_reply' : sanitizePeerText(r.error?.code, 64) || 'unknown'
  } catch (err) {
    console.error('hand-over session: start threw', err)
    code = 'internal'
  }
  // The reply must name a new session: one the journal does not know yet,
  // or a top-level conversation of the recipient's already announced from
  // exactly that box. A system conversation (People), a session on another
  // box, or a conversation with no box is a bad start, and joins nothing.
  const cur = convoId ? db.prepare('SELECT owner_user_id, agent_device_id, system, parent_convo_id FROM conversations WHERE id=?').get(convoId) : null
  if (cur && (cur.owner_user_id !== userId || cur.agent_device_id !== target.deviceId || cur.system != null || cur.parent_convo_id != null
      || db.prepare('SELECT 1 FROM mission_conversations WHERE convo_id=?').get(convoId))) { convoId = null; code = 'bad_start_reply' }
  if (!convoId) {
    cardLine(ctx, { userId, itemId, body: `Couldn't start a session: ${code}. The ${g.subject_kind} is yours; start one from your apps when you like.` })
    return 'failed'
  }
  const joined = safely('join the copy', () => {
    if (!cur) upsertConversation(db, { id: convoId, ownerUserId: userId, title: `Taking over: ${sanitizePeerText(copy.title, 160)}`.slice(0, 200), agentDeviceId: target.deviceId })
    const out = joinMission(db, { userId, missionId: copy.id, convoId, how: 'spawned' })
    if (out.action) {
      appendAndBroadcast(db, hub, {
        userId, convoId, sender: JOURNAL, type: MISSION_EVENT_TYPE,
        payload: missionMarkerPayload({ mission: out.mission, action: out.action, by: 'user', withTitle: markerTitleAllowed(db, out.mission.origin_convo_id, convoId) }),
      })
    }
    fanRetitled(db, hub, out.retitled)
    return out
  })
  const mission = getMission(db, userId, copy.id)
  cardLine(ctx, { userId, itemId, body: joined
    ? `Started a new session on ${box} for mission #${mission?.num ?? copy.num}.`
    : `Started a new session on ${box}, but it could not be put on mission #${copy.num}: join it from your apps.` })
  return 'started'
}
