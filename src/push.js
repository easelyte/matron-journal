import crypto from 'node:crypto'
import { snippetOf } from './journal.js'
import { clientIdleExpired } from './auth.js'
import { clientDevicesForPush, pruneApnsToken, pruneWebPushSubscription, unreadBadge } from './db.js'
import { getCoordinatorConvoId } from './coordinator.js'
import { wakesForYou } from './sync-scope.js'
import {
  effectiveEvents, eventKey, allowedForUser, allowedForDevice, getConvoNotify,
  holdsConsent, consentStillPending, notifyBadge,
} from './notify.js'
import { boxPlaintext, sealBox } from './push-box.js'
import { APS_ALERTS } from './relay.js'
import { inlineRefsToText } from './inline-refs.js'
import { isSilentEvent } from './message-types.js'
import { isPanicLocked } from './panic.js'

// Min gap between routine (priority-5) pushes to the same (device, convo).
const ROUTINE_COALESCE_MS = 10000
// How long a consent card's push waits for the Coordinator to decide it, in
// Coordinator mode (notification settings).
export const CONSENT_HOLD_MS = 30000
// How long a push about a tracker item that needs the user waits before it
// goes out (MATRON_PUSH_HOLD_MS; 0 sends at once). Many such items are
// settled within seconds of being filed: the Coordinator decides a card, an
// agent closes what it filed or hands it back to itself. The push goes out
// only if the item is still open and still awaiting the user when the hold
// ends, so those never buzz a phone. The server uses this for the consent
// hold too, so one knob says how long the user's pocket waits.
export const FOR_YOU_HOLD_MS = 60 * 1000
// At startup, an ask whose hold had not run out by the time the process went
// down gets the push the restart swallowed. Older asks either got theirs
// before the restart or were never held; resuming them would push twice.
// The slack covers the restart's own downtime.
export const CONSENT_RESUME_SLACK_MS = 60 * 1000
// Min gap between silent background wakes to one device. Apple advises at
// most two or three background pushes an hour and throttles beyond that, so
// a wake sent more often than this is wasted budget, not fresher data.
export const BACKGROUND_WAKE_MS = 20 * 60 * 1000

// Returns null for event types that must not push at all. Product call
// (dispatcher decision): convo_meta (a title rename) is always journal-sync
// material — every connected device learns it from the journal frame, and
// nothing about a rename warrants buzzing a pocket. prompt/permission_request
// already cover "the session needs you" and always push.
//
// session_status is keyed off the TRANSITION, not the new state alone: a
// 'done' push must fire when the agent FINISHES ITS TURN, not whenever the
// session table happens to read 'done'. running -> waiting (turn finished)
// and running -> done (crashed, or stopped mid-work) both push kind 'done'.
// Every other transition is silent — in particular waiting -> done (the
// idle-reaper or /stop tearing down a session that was already waiting on
// the user) and a brand-new conversation's first state; those are
// journal-sync material other devices pick up from the frame itself.
// `prevState` is an in-memory-only hint threaded from ws.js's convo_upsert
// handler through onAppend's `pushHint` param (see below) — it is never
// stored in the event payload or broadcast on the wire, so the protocol
// surface is unchanged. Absent (e.g. a call site that doesn't pass one) is
// treated as "not running" — fails closed for this rule specifically.
export function classify(type, payload, sender, prevState) {
  // A user's own words/actions (sender `user:*`) must never trigger an
  // alert push, to ANY of that user's devices — not just the originating
  // one (that's origin-device exclusion, a separate, narrower rule below).
  // Mirrors the unread predicate (journal.js append()/markRead(): a
  // `user:*` sender never counts as unread either) — your own message must
  // not ring your other phone, same as it doesn't inflate your own unread
  // badge. (T2). read_marker is handled entirely separately (its own
  // background-push branch in onAppend, never reaches classify()) and keeps
  // its existing behavior regardless of sender.
  if (typeof sender === 'string' && sender.startsWith('user:')) return null
  // Old-client fallback (spec: "Old-client fallback"): a flagged text
  // mirrors a marker that already made its own push decision — this rule
  // has to check the agent sender too, since a `commented`/`closed`/
  // `reopened` fallback from an agent would otherwise read as a normal
  // agent-authored text and push a second time for one event.
  if (type === 'text' && payload && typeof payload === 'object' && payload.fallback_for) return null
  // A silent event (src/message-types.js) is there to be read in the chat,
  // never to tell anyone: a card recording the reminder an agent set itself.
  if (isSilentEvent(payload)) return null
  if (type === 'prompt' || type === 'permission_request') return { priority: 10, coalesce: false, kind: 'attention' }
  if (type === 'session_status') {
    const state = payload && payload.state
    const turnFinished = prevState === 'running' && (state === 'waiting' || state === 'done')
    // `stopped` (running -> done: crashed or stopped mid-work) is its own
    // switch in the notification settings; its APNs category stays 'done'.
    return turnFinished ? { priority: 10, coalesce: false, kind: 'done', stopped: state === 'done' } : null
  }
  if (type === 'convo_meta') return null
  // TOC summary events are derived metadata, not new activity — journal-sync only.
  if (type === 'summary') return null
  // Tracker markers (spec: task-decision-tracker ~:207-210). Only "the
  // agent needs you" pushes: an agent-authored create, comment, or reopen
  // that leaves the item awaiting the user. The `by === 'agent'` guard
  // applies to EVERY action, `created` included — an agent filing on the
  // user's behalf (`on_behalf_of:'user'`, the queued-card "Make task" tap)
  // writes `by:'user'`, and buzzing someone's pocket about the item they
  // just asked for is the same self-notification the user:* rule above
  // exists to prevent (that rule doesn't catch it: the sender is the agent
  // device). Agent closes, reorders, updates, and every user-authored
  // marker are journal-sync only.
  if (type === 'item') {
    const p = payload && typeof payload === 'object' ? payload : {}
    const needsUser = p.awaiting === 'user' && p.by === 'agent'
      && (p.action === 'created' || p.action === 'commented' || p.action === 'reopened')
    return needsUser ? { priority: 10, coalesce: false, kind: 'attention', question: true, ...(p.kind === 'notice' ? { notice: true } : {}) } : null
  }
  // Missions and milestones are navigation, never a push (spec: Marker events).
  if (type === 'milestone' || type === 'mission') return null
  // A Coordinator consent decision is a badge on a card the user already
  // saw, not new attention.
  if (type === 'consent_decision') return null
  // Routine content: text/tool_output/diff/prompt_reply/file/image/etc. —
  // batched so a busy session is one updating notification, not hundreds.
  return { priority: 5, coalesce: true, kind: 'activity' }
}

const ITEM_KIND_LABELS = { question: 'Question', notice: 'To read', task: 'Task', decision: 'Decision' }

// What a notification says, before it is sealed for a device that
// registered a key (src/push-box.js). An item that needs the user reads as
// the item: its title, the text that came with it, and the buttons it
// offers now. Everything else reads as its conversation and a snippet.
// `itemBody(id)` fetches an item's own body, which the marker never carries.
export function pushContent(event, convo, cls, itemBody = () => null) {
  const base = { convoId: event.convo_id, seq: event.seq, kind: cls.kind }
  const convoTitle = convo.title || ''
  const p = event.payload
  if (event.type !== 'item' || !p || typeof p !== 'object') {
    return { ...base, title: convoTitle || 'Matron', body: snippetOf(event.type, p) }
  }
  const c = p.comment && typeof p.comment === 'object' ? p.comment : null
  const text = p.action === 'created' ? (itemBody(p.item_id) ?? c?.body) : c?.body
  let body = typeof text === 'string' ? inlineRefsToText(text) : ''
  if (!body.trim() && Array.isArray(c?.attachments) && c.attachments.length) body = 'Attachment'
  // The buttons on offer: the comment's own when it asks something, else the
  // item's while nobody has tapped one.
  const labels = (list) => (Array.isArray(list) ? list.filter((a) => typeof a === 'string' && a).slice(0, 4) : [])
  // A multi-select question is answered in the app (tick, then Send): a
  // notification button would send one label, so it offers none.
  const asked = c?.multi_select ? [] : labels(c?.actions)
  const actions = asked.length || c?.multi_select ? asked : (p.chosen_action == null && !p.multi_select ? labels(p.actions) : [])
  const label = ITEM_KIND_LABELS[p.kind] || 'Item'
  return {
    ...base,
    title: String(p.title || '') || label,
    subtitle: convoTitle ? `${label} · ${convoTitle}` : label,
    body,
    item: {
      id: String(p.item_id),
      num: Number(p.num) || 0,
      kind: String(p.kind || ''),
      actions,
      ...(asked.length && c?.id ? { reply_to: String(c.id) } : {}),
    },
  }
}

// A push about a tracker item that needs the user (classify: an agent's
// create, comment or reopen leaving it awaiting the user). These are the
// pushes the item hold delays.
function isHeldItem(event, cls) {
  return event.type === 'item' && !!cls && cls.question === true
    && typeof event.payload?.item_id === 'string' && event.payload.item_id !== ''
}

// Is the item still open and still waiting on the user? Anything else (closed,
// handed back to an agent, deleted) means the push would be stale.
function itemStillNeedsUser(db, userId, itemId) {
  return !!db.prepare("SELECT 1 FROM items WHERE id=? AND user_id=? AND state='open' AND awaiting='user'").get(itemId, userId)
}

// A held item marker as it reads now: the buttons the item and the comment
// offer at send time, not at filing time, so a notification never offers a
// button that has already been tapped or replaced.
export function freshItemEvent(db, userId, event) {
  const p = event.payload
  const row = db.prepare('SELECT actions, chosen_action, multi_select FROM items WHERE id=? AND user_id=?').get(p.item_id, userId)
  if (!row) return event
  const parse = (json) => { try { const v = JSON.parse(json); return Array.isArray(v) ? v : [] } catch { return [] } }
  let comment = p.comment
  if (comment && typeof comment === 'object' && typeof comment.id === 'string') {
    const c = db.prepare('SELECT actions, chosen_action, multi_select FROM item_comments WHERE id=? AND item_id=?').get(comment.id, p.item_id)
    if (c) comment = { ...comment, actions: c.chosen_action == null ? parse(c.actions) : [], multi_select: !!c.multi_select }
  }
  return { ...event, payload: { ...p, actions: parse(row.actions), chosen_action: row.chosen_action ?? null, multi_select: !!row.multi_select, ...(comment !== undefined ? { comment } : {}) } }
}

// APNs answers that mean the token itself will never be delivered to: 410
// Unregistered (the app was removed or the token retired) and 400
// BadDeviceToken (not a token APNs knows in that environment). A
// BadDeviceToken can come from a sandbox token sent to production, but the
// environment is registered alongside every token, so retrying the same pair
// can never succeed either; the prune log names the environment. Every other
// failure (rate limits, server errors, other 400s, the relay's own request
// validation, transport) is about the request or the service and keeps the
// token. DeviceTokenNotForTopic also keeps it: it is as likely to mean the
// journal's topic is misconfigured, and pruning on it would drop every token.
function isDeadToken({ status, reason }) {
  return status === 410 || (status === 400 && reason === 'BadDeviceToken')
}

// Wired in server.js after a successful journal append fans out (see the
// `fanOut` choke point in ws.js). `apnsClient` is the makeApnsClient()
// instance, or undefined when push is disabled (all onAppend calls become a
// cheap no-op).
// `classify` is injectable (defaults to the real classifier above) purely
// as a test seam — production callers never override it — so a test can
// exercise a hypothetical future `cls.kind` the settings don't know
// about without reaching into module internals.
export function makePushPipeline({ db, hub, apnsClient, webPushClient, coalesceMs = ROUTINE_COALESCE_MS, consentHoldMs = CONSENT_HOLD_MS, itemHoldMs = 0, resumeSlackMs = CONSENT_RESUME_SLACK_MS, backgroundWakeMs = 0, now = Date.now, clientIdleMs, classify: classifyEvent = classify } = {}) {
  const counters = { sent: 0, failed: 0, pruned: 0, byReason: {} }
  const webCounters = { sent: 0, failed: 0, pruned: 0, byReason: {} }

  // Coalescing state lives in memory only, keyed by `${deviceId}:${transport}:${convoId}`.
  // A process restart loses any pending trailing push — acceptable for v1;
  // the next routine event after restart just does a fresh leading-edge
  // send since no window is latched for it.
  const coalesceState = new Map()
  // Consent-card and item pushes waiting out their hold (memory only; see
  // resumeHeldConsent and resumeHeldItems for the restart case).
  const held = new Set()

  // The newest held push per item, `${userId}:${itemId}` -> seq: a later
  // marker about the same item replaces an earlier one still waiting, so
  // only the newest goes out (it would replace the older on screen anyway).
  const heldItems = new Map()

  // Holds an item push, then sends it only if it is still the item's newest
  // and the item still needs the user.
  function holdItem(ms, userId, event, send, what) {
    const key = `${userId}:${event.payload.item_id}`
    // Seq order, not arrival order: an older marker never displaces a newer one.
    if ((heldItems.get(key) ?? -Infinity) > event.seq) return
    heldItems.set(key, event.seq)
    hold(ms, () => {
      if (heldItems.get(key) !== event.seq) return
      heldItems.delete(key)
      if (itemStillNeedsUser(db, userId, event.payload.item_id)) send()
    }, what)
  }

  // Runs `fn` once `ms` have passed, unless close() comes first. Never keeps
  // the process alive, and never lets a throw escape the timer.
  function hold(ms, fn, what) {
    const timer = setTimeout(() => {
      held.delete(timer)
      try { fn() } catch (err) { console.error(`push: ${what} failed`, err) }
    }, ms)
    timer.unref()
    held.add(timer)
  }

  // APNs token -> when it was last sent a background wake. Keyed by token so a
  // reused device id or a reinstall starts fresh. Memory only, like the
  // coalescing state: a restart at worst sends one wake early. Entries past
  // the interval decide nothing, so maybeWake drops them.
  const lastWakeAt = new Map()

  const bumpReason = (key) => { counters.byReason[key] = (counters.byReason[key] || 0) + 1 }

  function handleResult(device, result) {
    if (result.status >= 200 && result.status < 300) {
      counters.sent += 1
      return
    }
    counters.failed += 1
    bumpReason(result.reason || (result.status === 0 ? 'transport' : String(result.status)))
    if (isDeadToken(result)) {
      // Retrying a dead token never succeeds, so it is pruned instead. Logged
      // only by the send that actually cleared it.
      if (pruneApnsToken(db, device.id, device.apns_token, device.apns_env)) {
        counters.pruned += 1
        console.error(`apns: device ${device.id} token rejected (${result.status}${result.reason ? ' ' + result.reason : ''}, env=${device.apns_env}) — token pruned until the app registers again`)
      }
    } else {
      console.error(`apns: device ${device.id} push failed: status=${result.status}${result.reason ? ' reason=' + result.reason : ''}`)
    }
  }

  function doSend(device, userId, opts) {
    // A panic-locked account (src/panic.js): nothing is pushed. Its only
    // client devices left are frozen ones, which get nothing but the means
    // to clear the lock. Checked at the send, so a push queued before the
    // lock is dropped too.
    if (isPanicLocked(db, userId)) return
    // `device` is as it was when the push was built, and a queued one may
    // be sent a while later: a device signed out since gets nothing. (One
    // that registered another push token meanwhile still gets the push at
    // the old one, with the fixed text only: currentKey below.)
    if (!db.prepare("SELECT 1 FROM devices WHERE id=? AND user_id=? AND kind='client'").get(device.id, userId)) return
    // Badge must reflect unread state as of the moment we actually transmit,
    // not whenever the push was built/scheduled — a coalesced or trailing
    // push can sit queued for up to `coalesceMs`, during which more events
    // can arrive (or the user can read elsewhere), making a badge captured
    // at build time stale by the time it's sent. Recomputed fresh on every
    // send, here, rather than once up in onAppend and closed over by the
    // opts builders.
    const badge = notifyBadge(db, userId, unreadBadge)
    const opts2 = { ...opts, payload: { ...opts.payload, aps: { ...opts.payload.aps, badge } } }
    // Fire and forget from the caller's perspective: apnsClient.send() is
    // documented to never reject, but the .catch() (and the sync try/catch —
    // doSend is also called from timer callbacks, where an escaped throw
    // would crash the process) are backstops so a bug there can never leak
    // an unhandled rejection or exception out of the push pipeline.
    try {
      Promise.resolve(apnsClient.send({ deviceToken: device.apns_token, env: device.apns_env, ...opts2 }))
        .then((result) => handleResult(device, result))
        .catch((err) => {
          counters.failed += 1
          bumpReason('internal')
          console.error('apns: send threw unexpectedly', err)
        })
    } catch (err) {
      counters.failed += 1
      bumpReason('internal')
      console.error('apns: send threw synchronously', err)
    }
  }

  function sendTransport(device, userId, opts, transport) {
    if (transport !== 'web') return doSend(device, userId, opts)
    // The same send-time checks as doSend, so a push queued before a panic
    // lock (a coalesced trailing push, a held consent push) or a sign-out is
    // dropped on the web path too.
    if (isPanicLocked(db, userId)) return
    if (!db.prepare("SELECT 1 FROM devices WHERE id=? AND user_id=? AND kind='client'").get(device.id, userId)) return
    const failed = (reason) => {
      webCounters.failed += 1
      webCounters.byReason[reason] = (webCounters.byReason[reason] || 0) + 1
    }
    // A trailing push must not use a subscription unregistered or claimed by
    // another device while it waited in the coalescing window.
    const current = db.prepare('SELECT endpoint, p256dh, auth FROM web_push_subscriptions WHERE device_id=?').get(device.id)
    if (!current || current.endpoint !== device.wp_endpoint || current.p256dh !== device.wp_p256dh || current.auth !== device.wp_auth) return
    try {
      Promise.resolve(webPushClient.send({ endpoint: device.wp_endpoint,
        p256dh: device.wp_p256dh, auth: device.wp_auth, ...opts }))
        .then((result) => {
          if (result.status >= 200 && result.status < 300) {
            webCounters.sent += 1
            return
          }
          failed(result.reason || (result.status === 0 ? 'transport' : String(result.status)))
          if ((result.status === 404 || result.status === 410)
            && pruneWebPushSubscription(db, device.id, device.wp_endpoint)) {
            webCounters.pruned += 1
            console.error(`web push: device ${device.id} subscription pruned (${new URL(device.wp_endpoint).hostname})`)
          }
        })
        .catch(() => failed('internal'))
    } catch { failed('internal') }
  }

  // Trailing-edge coalescing with a leading send when idle: the first
  // routine event for a (device, convo) pair sends immediately and latches
  // a window; further routine events within `coalesceMs` are held (latest
  // wins) and flushed once as a single trailing push when the window
  // elapses. Invariant: an entry exists in coalesceState iff its window
  // timer is armed — a timer that fires with nothing pending evicts the
  // entry, so the map never grows unboundedly across (device, convo) pairs.
  function scheduleRoutine(device, userId, convoId, buildOpts, transport = 'apns') {
    const key = `${device.id}:${transport}:${convoId}`
    const state = coalesceState.get(key)
    if (state) {
      state.pendingBuild = buildOpts // within the window: latest wins
      return
    }
    const fresh = { timer: null, pendingBuild: null }
    coalesceState.set(key, fresh)
    sendTransport(device, userId, buildOpts(), transport) // idle: leading send
    armWindow(key, fresh, device, userId, transport)
  }

  function armWindow(key, state, device, userId, transport) {
    state.timer = setTimeout(() => {
      const build = state.pendingBuild
      state.pendingBuild = null
      if (build) {
        sendTransport(device, userId, build(), transport) // trailing push, then a fresh window
        armWindow(key, state, device, userId, transport)
      } else {
        coalesceState.delete(key) // idle window: evict
      }
    }, coalesceMs)
    // Never keep the process alive for a pending trailing push; the state
    // is memory-only anyway (see comment above coalesceState).
    state.timer.unref()
  }

  // A phone only hears about new events while its app holds a socket, and iOS
  // suspends the app soon after it leaves the screen. This silent push lets
  // the app catch up in the background, so opening it does not start with a
  // long replay. It is decided apart from the alert below, and regardless of
  // the notification settings: it shows nothing, and those settings choose
  // what buzzes, not how fresh the app is. Leading edge only: when a burst
  // ends inside the interval the rest waits for the next event or the next
  // time the app opens, which is the most Apple's budget allows anyway.
  function maybeWake(userId, event, devices, originDeviceId) {
    if (!backgroundWakeMs) return
    for (const [token, at] of lastWakeAt) {
      if (now() - at >= backgroundWakeMs) lastWakeAt.delete(token)
    }
    let connected = null
    // A for_you phone (src/sync-scope.js) is woken only by what its For you
    // and mission screens show; the rest it fetches when a chat is opened.
    let forYouWake
    for (const device of devices) {
      if (device.id === originDeviceId || !device.apns_env) continue
      if (device.cursor >= event.seq) continue
      if (lastWakeAt.has(device.apns_token)) continue
      if (device.sync_scope === 'for_you') {
        forYouWake ??= wakesForYou(event, getCoordinatorConvoId(db, userId))
        if (!forYouWake) continue
      }
      connected ??= new Set(hub.connsOf(userId).map((c) => c.deviceId))
      if (connected.has(device.id)) continue
      sendWake(device, userId)
    }
  }

  function sendWake(device, userId) {
    if (backgroundWakeMs) lastWakeAt.set(device.apns_token, now())
    doSend(device, userId, {
      payload: { aps: { 'content-available': 1 } },
      priority: 5,
      pushType: 'background',
      category: 'wake',
    })
  }

  // `pushHint` is optional, in-memory-only extra context a caller (today:
  // ws.js's convo_upsert handler, for session_status's prevSessionState)
  // can pass through to classify(). Every other call site omits it.
  // `noHold` is internal: a held push's own, already-waited send.
  function onAppend(userId, event, originDeviceId, pushHint, { noHold = false } = {}) {
    if (!apnsClient && !webPushClient) return
    // A panic-locked account: nothing pushed (doSend, sendTransport), nothing queued.
    if (isPanicLocked(db, userId)) return
    const convo = db.prepare('SELECT id, title, parent_convo_id FROM conversations WHERE id=? AND owner_user_id=?').get(event.convo_id, userId)
    if (!convo) return
    // Silent children: a subagent's child conversation is exempt from APNs
    // entirely (mirrors the unread short-circuit in journal.js append()). This
    // short-circuits the whole pipeline — alerts, routine coalesced pushes, and
    // the read_marker background wake alike — before any device is considered,
    // so stale app versions stay silent for children too.
    if (convo.parent_convo_id != null) return
    // kind='client' only — agent devices are never pushed to.
    // A client that has idled out is signed out: no pushes until it signs in again.
    const pushNow = now()
    const devices = clientDevicesForPush(db, userId).filter((d) => !clientIdleExpired(d, pushNow, clientIdleMs))
    if (devices.length === 0) return
    // Badge is no longer captured here — doSend recomputes it fresh at
    // actual send time (see doSend), so a coalesced/deferred push never
    // reports a stale value.

    if (event.type === 'read_marker') {
      for (const device of devices) {
        if (device.id === originDeviceId) continue // never push a device its own read_marker
        if (!apnsClient || !device.apns_env) continue
        // A for_you phone has nothing to fetch for a read elsewhere, only a
        // badge to update, so its read wakes share the paced wakes' budget.
        if (device.sync_scope === 'for_you' && backgroundWakeMs && now() - (lastWakeAt.get(device.apns_token) ?? -Infinity) < backgroundWakeMs) continue
        sendWake(device, userId)
      }
      return
    }

    // Before the settings below can return. `noHold` is a held push's
    // second pass through here: its first pass has already been considered.
    if (apnsClient && !noHold) maybeWake(userId, event, devices, originDeviceId)

    const cls = classifyEvent(event.type, event.payload, event.sender, pushHint && pushHint.prevSessionState)
    if (!cls) return // journal-sync-only type (convo_meta, a session_status transition that isn't turn-finished), or a user's own event (T2)
    // Notification settings (spec 2026-10-01): the user's mode and event
    // switches, then this conversation's level or mute. Decided once per
    // event; the per-device level applies in the loop below.
    const coordinatorConvoId = getCoordinatorConvoId(db, userId)
    const { mode, events } = effectiveEvents(db, userId, undefined, coordinatorConvoId)
    const isCoordinator = coordinatorConvoId === event.convo_id
    const isRoom = cls.kind === 'activity' && !!db.prepare("SELECT 1 FROM convo_agents WHERE convo_id=? AND state='joined' LIMIT 1").get(event.convo_id)
    const key = eventKey(cls, { isCoordinator, isRoom })
    if (!allowedForUser(key, events, getConvoNotify(db, userId, event.convo_id))) return
    // A consent card the Coordinator may decide waits for it: the push goes
    // out after the hold only if the ask is still waiting on someone.
    const p = event.payload
    if (!noHold && event.type === 'permission_request' && p && (p.kind === 'agent_spawn' || p.kind === 'agent_chat')
      && holdsConsent(db, userId, mode, p.from_device_id)) {
      hold(consentHoldMs, () => {
        if (consentStillPending(db, p)) sendAlert(userId, event, convo, cls, key, devices, originDeviceId)
      }, 'held consent push')
      return
    }
    // An item that needs the user waits too, and goes out only if it still
    // does. The second pass runs the whole decision again, so the devices,
    // the settings and what each device has already seen are as they are
    // then: a phone that opened the app meanwhile gets nothing.
    if (!noHold && itemHoldMs > 0 && isHeldItem(event, cls)) {
      holdItem(itemHoldMs, userId, event, () => onAppend(userId, freshItemEvent(db, userId, event), originDeviceId, pushHint, { noHold: true }), 'held item push')
      return
    }
    sendAlert(userId, event, convo, cls, key, devices, originDeviceId)
  }

  function sendAlert(userId, event, convo, cls, key, devices, originDeviceId) {
    const title = convo.title || convo.id
    const body = snippetOf(event.type, event.payload)
    // Sealed content, for the devices that registered a key. Built once per
    // event, on first need; sealed per device, since each has its own key.
    let plain
    const plaintext = () => (plain ??= {
      bytes: boxPlaintext(pushContent(event, convo, cls,
        (id) => db.prepare('SELECT body FROM items WHERE id=? AND user_id=?').get(id, userId)?.body ?? null)),
    }).bytes
    // An item's notification stands for the item, so a second question in
    // one conversation does not replace the first on the lock screen, and a
    // follow-up on the same item does replace what it follows. APNs caps the
    // id at 64 bytes.
    const itemId = event.type === 'item' && typeof event.payload?.item_id === 'string' && event.payload.item_id.length <= 64
      ? event.payload.item_id : null
    const webContent = () => {
      try {
        const bytes = plaintext()
        if (bytes) return bytes
      } catch (err) {
        console.error('push: could not build web push content', err)
      }
      return Buffer.from(JSON.stringify({
        v: 1, ...(APS_ALERTS[cls.kind] ?? APS_ALERTS.activity),
        convo_id: event.convo_id, seq: event.seq, kind: cls.kind,
      }))
    }
    for (const device of devices) {
      // Origin-device exclusion, uniformly for every push type (not just
      // read_marker above): a device must never be pushed about an event it
      // itself originated. In practice today this only ever fires for
      // read_marker (agent-originated alert types never coincide with a
      // client push device; user:*-sourced alert types are already filtered
      // out by classify() above) — kept here anyway so the rule holds
      // uniformly rather than being asymmetrically special-cased.
      if (device.id === originDeviceId) continue
      // This device's own level ("On this device: all / needs me / off").
      if (!allowedForDevice(key, device.push_level)) continue
      if (hub.isViewing(userId, device.id, event.convo_id)) continue
      if (device.cursor >= event.seq) continue
      const buildOpts = () => {
        const key = currentKey(device)
        const box = sealedFor(device, key, plaintext)
        return {
          // seq (read state): the message this alert shows, so a tapped
          // notification can report that one message as seen.
          //
          // With a box, the visible alert is the fixed text the relay would
          // use: the content is in the box alone, on the direct APNs path
          // as well, and mutable-content hands it to the app's notification
          // extension to open.
          //
          // A device that registered a key never gets its content in the
          // clear: if the box could not be made, or its registration changed
          // while this push waited, the fixed text goes alone.
          payload: key || device.push_key
            ? { aps: { alert: APS_ALERTS[cls.kind] ?? APS_ALERTS.activity, 'thread-id': event.convo_id, 'mutable-content': 1 }, seq: event.seq, ...(box ? { box } : {}) }
            : { aps: { alert: { title, body }, 'thread-id': event.convo_id }, seq: event.seq },
          priority: cls.priority,
          pushType: 'alert',
          collapseId: (box && itemId) || event.convo_id,
          category: cls.kind,
        }
      }
      if (webPushClient && device.wp_endpoint) {
        // Built inside the send path's own timers too, so it must not throw:
        // content that cannot be built goes out as the fixed text.
        const buildWeb = () => ({
          payload: webContent(),
          urgency: cls.priority === 10 ? 'high' : 'normal',
          topic: crypto.createHash('sha256').update(itemId || event.convo_id).digest('base64url').slice(0, 32),
          ttl: cls.kind === 'activity' ? 3600 : 86400,
        })
        if (cls.coalesce) scheduleRoutine(device, userId, event.convo_id, buildWeb, 'web')
        else sendTransport(device, userId, buildWeb(), 'web')
      }
      if (!apnsClient || !device.apns_token || !device.apns_env) continue
      if (cls.coalesce) {
        scheduleRoutine(device, userId, event.convo_id, buildOpts)
      } else {
        doSend(device, userId, buildOpts())
      }
    }
  }

  // The key the device holds now, for the token this push goes to. Read at
  // send time: a coalesced push can wait out its window, and a registration
  // made meanwhile must not get a box sealed to the key it replaced.
  function currentKey(device) {
    return db.prepare('SELECT push_key FROM devices WHERE id=? AND apns_token=?').get(device.id, device.apns_token)?.push_key ?? null
  }

  // The box for one device, or null: no key registered, or sealing failed
  // (the push then goes out with the fixed text alone).
  function sealedFor(device, key, plaintext) {
    if (!key) return null
    try {
      const bytes = plaintext()
      return bytes ? sealBox(key, bytes) : null
    } catch (err) {
      console.error(`push: could not seal content for device ${device.id}`, err)
      return null
    }
  }

  // After a restart: a consent card whose hold the restart swallowed still
  // gets its push, if the ask is still pending. Only cards young enough to
  // have been mid-hold, and only where the hold applies now (the same gate
  // onAppend uses) — a card that pushed at once must not push again. Held
  // again for whatever is left of its hold; sent now if that has passed.
  // The partial index idx_events_permission_request keeps this off a full
  // events scan.
  function resumeHeldConsent(now = Date.now()) {
    if (!apnsClient && !webPushClient) return 0
    const rows = db.prepare(`SELECT user_id, seq, convo_id, ts, sender, type, payload FROM events
      WHERE type='permission_request' AND ts > ?`).all(now - consentHoldMs - resumeSlackMs)
    let n = 0
    for (const r of rows) {
      let payload
      try { payload = JSON.parse(r.payload) } catch { continue }
      if (!payload || (payload.kind !== 'agent_spawn' && payload.kind !== 'agent_chat')) continue
      if (!consentStillPending(db, payload)) continue
      if (!holdsConsent(db, r.user_id, effectiveEvents(db, r.user_id).mode, payload.from_device_id)) continue
      const event = { seq: r.seq, convo_id: r.convo_id, ts: r.ts, sender: r.sender, type: r.type, payload }
      hold(Math.max(0, r.ts + consentHoldMs - now), () => {
        if (consentStillPending(db, payload)) onAppend(r.user_id, event, null, undefined, { noHold: true })
      }, 'resumed consent push')
      n += 1
    }
    return n
  }

  // After a restart: an item push whose hold the restart swallowed still
  // goes out, if the item still needs the user. Same window and rule as
  // resumeHeldConsent: only markers young enough to have been mid-hold.
  // A consent mirror's marker never pushes (it carries `consent`), so it is
  // skipped here too. The partial index idx_events_item keeps this off a
  // full events scan.
  function resumeHeldItems(now = Date.now()) {
    if ((!apnsClient && !webPushClient) || itemHoldMs <= 0) return 0
    const rows = db.prepare(`SELECT user_id, seq, convo_id, ts, sender, type, payload FROM events
      WHERE type='item' AND ts > ? ORDER BY seq`).all(now - itemHoldMs - resumeSlackMs)
    let n = 0
    for (const r of rows) {
      let payload
      try { payload = JSON.parse(r.payload) } catch { continue }
      if (!payload || typeof payload !== 'object' || payload.consent != null) continue
      const event = { seq: r.seq, convo_id: r.convo_id, ts: r.ts, sender: r.sender, type: r.type, payload }
      const cls = classifyEvent(event.type, payload, event.sender)
      if (!isHeldItem(event, cls) || !itemStillNeedsUser(db, r.user_id, payload.item_id)) continue
      holdItem(Math.max(0, r.ts + itemHoldMs - now), r.user_id, event,
        () => onAppend(r.user_id, freshItemEvent(db, r.user_id, event), null, undefined, { noHold: true }), 'resumed item push')
      n += 1
    }
    return n
  }

  function close() {
    for (const state of coalesceState.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    coalesceState.clear()
    for (const timer of held) clearTimeout(timer)
    held.clear()
    heldItems.clear()
  }

  // _coalesceState is exposed for tests (eviction assertions) and as a
  // cheap gauge candidate for Task 5's /metrics; not part of the public API.
  return { onAppend, resumeHeldConsent, resumeHeldItems, counters, webCounters, close, _coalesceState: coalesceState, _held: held }
}
