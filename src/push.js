import { snippetOf } from './journal.js'
import { clientDevicesForPush, parsePushPrefs, pruneApnsToken, unreadBadge } from './db.js'
import { getCoordinatorConvoId } from './coordinator.js'
import {
  effectiveEvents, eventKey, allowedForUser, allowedForDevice, getConvoNotify,
  holdsConsent, consentStillPending, notifyBadge,
} from './notify.js'

// Min gap between routine (priority-5) pushes to the same (device, convo).
const ROUTINE_COALESCE_MS = 10000
// How long a consent card's push waits for the Coordinator to decide it, in
// Coordinator mode (notification settings).
export const CONSENT_HOLD_MS = 30000
// At startup, an ask whose hold had not run out by the time the process went
// down gets the push the restart swallowed. Older asks either got theirs
// before the restart or were never held; resuming them would push twice.
// The slack covers the restart's own downtime.
export const CONSENT_RESUME_SLACK_MS = 60 * 1000

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
  if (type === 'prompt' || type === 'permission_request') return { priority: 10, coalesce: false, kind: 'attention' }
  if (type === 'session_status') {
    const state = payload && payload.state
    const turnFinished = prevState === 'running' && (state === 'waiting' || state === 'done')
    // `stopped` (running -> done: crashed or stopped mid-work) is its own
    // switch in the notification settings; the kind stays 'done' for the
    // legacy per-device prefs.
    return turnFinished ? { priority: 10, coalesce: false, kind: 'done', stopped: state === 'done' } : null
  }
  if (type === 'convo_meta') return null
  // TOC summary events are derived metadata, not new activity — journal-sync only.
  if (type === 'summary') return null
  if (type === 'peer_message') return { priority: 5, coalesce: true, kind: 'activity' }
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

// Wired in server.js after a successful journal append fans out (see the
// `fanOut` choke point in ws.js). `apnsClient` is the makeApnsClient()
// instance, or undefined when push is disabled (all onAppend calls become a
// cheap no-op).
// `classify` is injectable (defaults to the real classifier above) purely
// as a test seam — production callers never override it — so a test can
// exercise a hypothetical future `cls.kind` the prefs object doesn't know
// about without reaching into module internals.
export function makePushPipeline({ db, hub, apnsClient, coalesceMs = ROUTINE_COALESCE_MS, consentHoldMs = CONSENT_HOLD_MS, resumeSlackMs = CONSENT_RESUME_SLACK_MS, classify: classifyEvent = classify } = {}) {
  const counters = { sent: 0, failed: 0, pruned: 0, byReason: {} }

  // Coalescing state lives in memory only, keyed by `${deviceId}:${convoId}`.
  // A process restart loses any pending trailing push — acceptable for v1;
  // the next routine event after restart just does a fresh leading-edge
  // send since no window is latched for it.
  const coalesceState = new Map()
  // Consent-card pushes waiting out their hold (memory only; see
  // resumeHeldConsent for the restart case).
  const held = new Set()

  const bumpReason = (key) => { counters.byReason[key] = (counters.byReason[key] || 0) + 1 }

  function handleResult(device, result) {
    if (result.status >= 200 && result.status < 300) {
      counters.sent += 1
      return
    }
    counters.failed += 1
    bumpReason(result.reason || (result.status === 0 ? 'transport' : String(result.status)))
    if (result.status === 410) {
      // Dead token: prune instead of retrying it forever.
      pruneApnsToken(db, device.id)
      counters.pruned += 1
      console.error(`apns: device ${device.id} unregistered (410${result.reason ? ' ' + result.reason : ''}) — token pruned`)
    } else if (result.status === 400) {
      // Sygnal lesson: this is almost always a sandbox/prod environment
      // mismatch, not a dead token — keep it, but log loudly so it gets fixed.
      console.error(`apns: device ${device.id} got 400${result.reason ? ' ' + result.reason : ''} — keeping token, check apns_env (env=${device.apns_env})`)
    } else {
      console.error(`apns: device ${device.id} push failed: status=${result.status}${result.reason ? ' reason=' + result.reason : ''}`)
    }
  }

  function doSend(device, userId, opts) {
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

  // Trailing-edge coalescing with a leading send when idle: the first
  // routine event for a (device, convo) pair sends immediately and latches
  // a window; further routine events within `coalesceMs` are held (latest
  // wins) and flushed once as a single trailing push when the window
  // elapses. Invariant: an entry exists in coalesceState iff its window
  // timer is armed — a timer that fires with nothing pending evicts the
  // entry, so the map never grows unboundedly across (device, convo) pairs.
  function scheduleRoutine(device, userId, convoId, buildOpts) {
    const key = `${device.id}:${convoId}`
    const state = coalesceState.get(key)
    if (state) {
      state.pendingBuild = buildOpts // within the window: latest wins
      return
    }
    const fresh = { timer: null, pendingBuild: null }
    coalesceState.set(key, fresh)
    doSend(device, userId, buildOpts()) // idle: leading send
    armWindow(key, fresh, device, userId)
  }

  function armWindow(key, state, device, userId) {
    state.timer = setTimeout(() => {
      const build = state.pendingBuild
      state.pendingBuild = null
      if (build) {
        doSend(device, userId, build()) // trailing push, then a fresh window
        armWindow(key, state, device, userId)
      } else {
        coalesceState.delete(key) // idle window: evict
      }
    }, coalesceMs)
    // Never keep the process alive for a pending trailing push; the state
    // is memory-only anyway (see comment above coalesceState).
    state.timer.unref()
  }

  // `pushHint` is optional, in-memory-only extra context a caller (today:
  // ws.js's convo_upsert handler, for session_status's prevSessionState)
  // can pass through to classify(). Every other call site omits it.
  // `noHold` is internal: resumeHeldConsent's own, already-waited send.
  function onAppend(userId, event, originDeviceId, pushHint, { noHold = false } = {}) {
    if (!apnsClient) return
    const convo = db.prepare('SELECT id, title, parent_convo_id FROM conversations WHERE id=? AND owner_user_id=?').get(event.convo_id, userId)
    if (!convo) return
    // Silent children: a subagent's child conversation is exempt from APNs
    // entirely (mirrors the unread short-circuit in journal.js append()). This
    // short-circuits the whole pipeline — alerts, routine coalesced pushes, and
    // the read_marker background wake alike — before any device is considered,
    // so stale app versions stay silent for children too.
    if (convo.parent_convo_id != null) return
    // kind='client' only — agent devices are never pushed to.
    const devices = clientDevicesForPush(db, userId)
    if (devices.length === 0) return
    // Badge is no longer captured here — doSend recomputes it fresh at
    // actual send time (see doSend), so a coalesced/deferred push never
    // reports a stale value.

    if (event.type === 'read_marker') {
      for (const device of devices) {
        if (device.id === originDeviceId) continue // never push a device its own read_marker
        if (!device.apns_env) continue
        doSend(device, userId, {
          payload: { aps: { 'content-available': 1 } },
          priority: 5,
          pushType: 'background',
          category: 'wake',
        })
      }
      return
    }

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
      const timer = setTimeout(() => {
        held.delete(timer)
        try {
          if (consentStillPending(db, p)) sendAlert(userId, event, convo, cls, key, devices, originDeviceId)
        } catch (err) {
          console.error('push: held consent push failed', err)
        }
      }, consentHoldMs)
      timer.unref()
      held.add(timer)
      return
    }
    sendAlert(userId, event, convo, cls, key, devices, originDeviceId)
  }

  function sendAlert(userId, event, convo, cls, key, devices, originDeviceId) {
    const title = convo.title || convo.id
    const body = snippetOf(event.type, event.payload)
    for (const device of devices) {
      // Origin-device exclusion, uniformly for every push type (not just
      // read_marker above): a device must never be pushed about an event it
      // itself originated. In practice today this only ever fires for
      // read_marker (agent-originated alert types never coincide with a
      // client push device; user:*-sourced alert types are already filtered
      // out by classify() above) — kept here anyway so the rule holds
      // uniformly rather than being asymmetrically special-cased.
      if (device.id === originDeviceId) continue
      if (!device.apns_env) continue
      // This device's own level ("On this device: all / needs me / off").
      if (!allowedForDevice(key, device.push_level)) continue
      // Legacy per-device prefs (PUT /push/prefs), only where a device ever
      // stored some: a NULL row's defaults (activity off) would otherwise
      // overrule the user's synced switches. Skip the device only when its
      // prefs explicitly disable this event's category; a `cls.kind` absent
      // from the prefs object fails open rather than muting every device.
      if (device.push_prefs != null && parsePushPrefs(device.push_prefs)[cls.kind] === false) continue
      if (hub.isViewing(userId, device.id, event.convo_id)) continue
      if (device.cursor >= event.seq) continue
      const buildOpts = () => ({
        // seq (read state): the message this alert shows, so a tapped
        // notification can report that one message as seen.
        payload: { aps: { alert: { title, body }, 'thread-id': event.convo_id }, seq: event.seq },
        priority: cls.priority,
        pushType: 'alert',
        collapseId: event.convo_id,
        category: cls.kind,
      })
      if (cls.coalesce) {
        scheduleRoutine(device, userId, event.convo_id, buildOpts)
      } else {
        doSend(device, userId, buildOpts())
      }
    }
  }

  // After a restart: a consent card whose hold the restart swallowed still
  // gets its push, if the ask is still pending. Only cards young enough to
  // have been mid-hold, and only where the hold applies now (the same gate
  // onAppend uses) — a card that pushed at once must not push again. Held
  // again for whatever is left of its 30 s; sent now if that has passed.
  // The partial index idx_events_permission_request keeps this off a full
  // events scan.
  function resumeHeldConsent(now = Date.now()) {
    if (!apnsClient) return 0
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
      const timer = setTimeout(() => {
        held.delete(timer)
        try {
          if (consentStillPending(db, payload)) onAppend(r.user_id, event, null, undefined, { noHold: true })
        } catch (err) {
          console.error('push: resumed consent push failed', err)
        }
      }, Math.max(0, r.ts + consentHoldMs - now))
      timer.unref()
      held.add(timer)
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
  }

  // _coalesceState is exposed for tests (eviction assertions) and as a
  // cheap gauge candidate for Task 5's /metrics; not part of the public API.
  return { onAppend, resumeHeldConsent, counters, close, _coalesceState: coalesceState, _held: held }
}
