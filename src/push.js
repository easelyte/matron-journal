import { snippetOf } from './journal.js'
import { clientDevicesForPush, parsePushPrefs, pruneApnsToken, unreadBadge } from './db.js'

// Min gap between routine (priority-5) pushes to the same (device, convo).
const ROUTINE_COALESCE_MS = 10000

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
function classify(type, payload, sender, prevState) {
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
  if (type === 'prompt' || type === 'permission_request') return { priority: 10, coalesce: false, kind: 'attention' }
  if (type === 'session_status') {
    const state = payload && payload.state
    const turnFinished = prevState === 'running' && (state === 'waiting' || state === 'done')
    return turnFinished ? { priority: 10, coalesce: false, kind: 'done' } : null
  }
  if (type === 'convo_meta') return null
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
export function makePushPipeline({ db, hub, apnsClient, coalesceMs = ROUTINE_COALESCE_MS, classify: classifyEvent = classify } = {}) {
  const counters = { sent: 0, failed: 0, pruned: 0, byReason: {} }

  // Coalescing state lives in memory only, keyed by `${deviceId}:${convoId}`.
  // A process restart loses any pending trailing push — acceptable for v1;
  // the next routine event after restart just does a fresh leading-edge
  // send since no window is latched for it.
  const coalesceState = new Map()

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
    const badge = unreadBadge(db, userId)
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
  function onAppend(userId, event, originDeviceId, pushHint) {
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
      // Per-device notification prefs: skip the device only when its prefs
      // explicitly disable this event's category. Deliberately BEFORE the
      // isViewing/cursor checks (cheapest first) and only on the alert path —
      // read_marker wakes above are invisible to the user and never filtered.
      // A `cls.kind` absent from the prefs object (a future category prefs
      // hasn't caught up to) fails open rather than muting every device —
      // matches the module's documented fail-open rule.
      if (parsePushPrefs(device.push_prefs)[cls.kind] === false) continue
      if (hub.isViewing(userId, device.id, event.convo_id)) continue
      if (device.cursor >= event.seq) continue
      const buildOpts = () => ({
        payload: { aps: { alert: { title, body }, 'thread-id': event.convo_id } },
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

  function close() {
    for (const state of coalesceState.values()) {
      if (state.timer) clearTimeout(state.timer)
    }
    coalesceState.clear()
  }

  // _coalesceState is exposed for tests (eviction assertions) and as a
  // cheap gauge candidate for Task 5's /metrics; not part of the public API.
  return { onAppend, counters, close, _coalesceState: coalesceState }
}
