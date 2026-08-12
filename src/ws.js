import { randomUUID } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { authToken, authorizeAgentWrite } from './auth.js'
import { applyBridgePrivate, isPrivateDevice } from './db.js'
import { eventsAfter, append, appendAndBroadcast, markRead, upsertConversation, toEventShape, isClientOnlyEvent, CONVO_ID_MAX_CHARS } from './journal.js'
import { joinedAgentIds, answerInvite, leaveConvo, leaveAllParticipants, hasParticipants, getParticipant, isKnownParticipant, expireInvites, parkInvite, expireAwaiting } from './participants.js'
import { sanitizePeerText, PEER_NAME_CAP } from './peer-text.js'
import { deliverPendingInvites } from './invite-delivery.js'
import { countPendingAsks, createSpawnRequest, discardSpawnRequest, expireSpawns, expireApproved, sanitizeSpawnActivity, sanitizeSpawnLimits } from './spawns.js'

const journalFrame = (e) => ({ kind: 'journal', ...toEventShape(e) })

// file/image sends carry a blob_ref pointing at a prior POST /media upload;
// the payload mirrors the agent-publish shape ({blob_ref, name, content_type,
// size}) so renderers treat both directions identically.
const CLIENT_SEND_TYPES = new Set(['text', 'file', 'image'])

// Exactly what an agent may hand-author via `publish`. `session_status` is
// server-generated (only reachable via convo_upsert); `read_marker` and
// `convo_meta` are server-generated too (read_marker via the read_marker op,
// convo_meta via convo_upsert's title-change detection) — none of the three
// may be forged through a bare publish. Unknown/future types arrive via a
// server upgrade to this whitelist, never through a bare agent frame.
const AGENT_PUBLISH_TYPES = new Set([
  'text', 'prompt', 'prompt_reply', 'tool_output', 'diff',
  'permission_request', 'file', 'image', 'edit', 'summary',
])

// activity op (typing/tool-use indicators, spec §6 ephemeral): the only
// states a bridge may broadcast. Anything else is bad_request.
const ACTIVITY_STATES = new Set(['thinking', 'tool', 'idle'])
const ACTIVITY_DETAIL_MAX_CHARS = 200

// status op (session header data — model, context gauge, rate limits):
// ephemeral like activity, but the last one per convo is cached and replayed
// on viewing so client headers populate on open. The payload is passed
// through opaquely (the bridge owns the shape; see the bridge's
// lib/session-status.js) but size-capped — it's held in server memory, so an
// unbounded status would be an unbounded hold.
const STATUS_MAX_BYTES = 4096
const STATUS_CACHE_MAX = 2048

// host_vitals op (host-global machine sample — cpu/ram/sampled_at_ms): a
// pure ephemeral like status, but NOT convo-scoped. The bridge emits it
// without a convo_id at a slow cadence (~5s); the server relays it to every
// one of the user's clients and caches the LAST sample per user so a fresh
// client paints immediately on connect. Size-capped (same ceiling as status)
// because it's held in server memory. Never journaled.
const VITALS_CACHE_MAX = 2048
// Server-side floor between accepted host_vitals frames from one agent
// connection. Our bridge samples at ~5s so this never trips in normal
// operation — it's a defense against a runaway/buggy agent flooding the op;
// excess frames are dropped silently (telemetry, not a protocol error).
const VITALS_MIN_INTERVAL_MS = 1000

// Agent RPC (spec 2026-07-15-agent-rpc-design.md): opaque client->agent
// request/response relay, never journaled. Whole-frame byte cap — larger
// payloads belong in POST /media with a blob_ref inside params.
const RPC_MAX_BYTES = 16384
const RPC_ID_MAX_CHARS = 128
const RPC_NAME_MAX_CHARS = 64 // method and error.code
// CONVO_ID_MAX_CHARS (128, imported above) caps a parent_convo_id sent by a
// bridge — see its doc comment in journal.js for why it lives there.
// Cap for a session_outcome sent by a bridge. Shape-only, like the
// parent_convo_id check: the outcome vocabulary belongs to the writing bridge
// (today 'completed' | 'interrupted' | 'failed'), and the journal deliberately
// does not enumerate it — see the session_outcome column comment in db.js.
const SESSION_OUTCOME_MAX_CHARS = 32

// Invite lifecycle (spec: agent chat phase 2). Topic is a title fragment;
// justification/reason are one-paragraph human text — capped so a row/frame
// stays small, same defensive stance as ACTIVITY_DETAIL_MAX_CHARS.
const INVITE_TOPIC_MAX_CHARS = 200
const INVITE_TEXT_MAX_CHARS = 1000
// Spawn asks (spec: 2026-08-09 agent-spawned sessions). task is BOTH the
// child's seed prompt and the card text the user approves — one blob, so
// the text the user reads is the text that takes effect.
const SPAWN_TASK_MAX_CHARS = 2000
const SPAWN_WORKDIR_MAX_CHARS = 1024
// Conversation titles quoted on a consent card to say WHICH session is
// asking and which is being asked (spec: agent chat request naming). Titles
// are agent-written, so they are peer text like from_name and get the same
// sanitising; the cap is tighter than a topic's because these are rendered
// as identity on one line, not as body copy.
const CARD_TITLE_MAX_CHARS = 120
// Consent-gate constants (spec: agent chat consent). AWAITING_USER_TTL_MS is
// the 24h clock the sweep uses (see the sweep timer's expireAwaiting loop)
// to expire a parked ask nobody ever answered. MAX_AWAITING_PER_REQUESTER
// caps how many asks a single device can have parked at once, across every
// room, so one chatty agent can't flood the user's attention queue.
// (PEER_NAME_CAP, which bounds the sanitised from_name embedded in a consent
// card, now lives in peer-text.js — http.js applies the same cap.)
const AWAITING_USER_TTL_MS = 24 * 3600_000
const MAX_AWAITING_PER_REQUESTER = 3
// Stranded-'approved' recovery TTL floor (see spawns.js expireApproved's
// doc comment) — comfortably beyond the 30s default start timeout so this
// sweep never races a live approveSpawn still legitimately in flight, but
// short enough that a restart-before-settle gap doesn't leave the parent
// hanging for anywhere near as long as the 24h awaiting-user TTL above.
// A FLOOR, not the value: spawnStartTimeoutMs is configurable, and a start
// timeout raised past this constant would let the sweep fail a row whose
// orchestration is still legitimately awaiting the target's reply — the
// effective TTL is derived in attachWs (2x the start timeout, at minimum
// this) so the two configs can never cross.
const APPROVED_ORPHAN_TTL_FLOOR_MS = 5 * 60_000
// Cap for a convo_upsert's rolling summary (spec: agent chat phase 2) — same
// defensive stance as the invite text caps above.
const SUMMARY_MAX_CHARS = 1000
const SESSION_ACK_STATES = new Set(['idle', 'busy'])

// The five room-lifecycle ops. Their error frames carry the inbound
// room_id (see fail below) — a bridge can have several rooms' ops in
// flight at once, and `ref` alone can't say which room an error is about.
const ROOM_OPS = new Set(['agent_invite', 'agent_join', 'agent_invite_ack', 'agent_invite_answer', 'agent_leave'])

// The room_id echo, as a spreadable fragment ({} when there's nothing safe
// to echo). Module-level rather than a closure inside handleOp's `fail`
// because the OUTERMOST backstop — the internal-error frame sent when
// something unexpected escapes handleOp entirely — needs the identical
// predicate, and that frame is emitted from the socket's message handler,
// where `fail` doesn't exist. An 'internal' error is exactly the case a
// bridge can least afford to leave uncorrelated. Only echoes an id that
// would pass loadRoom's own shape check; an invalid/oversized room_id is
// raw inbound input and must never be reflected back. `msg` may be
// absent/unparsed at the backstop, hence the null guard.
function roomIdEcho(msg) {
  const roomId = msg && ROOM_OPS.has(msg.op)
    && typeof msg.room_id === 'string' && msg.room_id && msg.room_id.length <= CONVO_ID_MAX_CHARS
    ? msg.room_id : null
  return roomId ? { room_id: roomId } : {}
}

// Last status per (user, convo). In-memory only and bounded (oldest-written
// evicted first): a lost entry just means the header stays blank until the
// next turn end repaints it. Exported for direct unit testing.
export function makeStatusCache(max = STATUS_CACHE_MAX) {
  const map = new Map()
  return {
    set(userId, convoId, status) {
      const key = `${userId}:${convoId}`
      if (map.has(key)) map.delete(key)
      map.set(key, status)
      if (map.size > max) map.delete(map.keys().next().value)
    },
    get(userId, convoId) {
      return map.get(`${userId}:${convoId}`)
    },
  }
}

// Last host_vitals per user. In-memory only and bounded (oldest-written
// evicted first): host-global, so a single value per user, not per convo. A
// lost entry just means a reconnecting client waits up to one sample interval
// for the next tick. Exported for direct unit testing.
//
// KNOWN LIMITATION (single-host): keyed by userId alone, so if one user ran
// TWO bridges on different machines their samples would collapse onto one
// cache slot (last writer wins) and clients could not tell them apart. Our
// deployment is single-VPS / single-bridge per user, so this does not bite.
// True multi-bridge / multi-VPS per-host telemetry (device-keyed cache +
// client host-selection UX) is deferred to matron loop #542 (the
// multi-account / multi-VPS dashboard). Do NOT add device-keying here now.
export function makeVitalsCache(max = VITALS_CACHE_MAX) {
  const map = new Map()
  return {
    set(userId, vitals) {
      if (map.has(userId)) map.delete(userId)
      map.set(userId, vitals)
      if (map.size > max) map.delete(map.keys().next().value)
    },
    get(userId) {
      return map.get(userId)
    },
  }
}

const MAX_WS_PAYLOAD_BYTES = 1048576 // 1 MiB

// Between replay batches, a slow/paused reader must not let the server
// buffer an unbounded amount of backlog in the socket's outgoing queue.
const REPLAY_BACKPRESSURE_BYTES = 4 * 1024 * 1024 // 4 MB

// Efficiency valve (spec §6): a resume gap this large (device offline for
// months, or a fresh install with cursor 0 against a huge journal) isn't
// worth replaying frame-by-frame. Journal rows are never deleted, so this
// is never a data-loss boundary — just a "go get a snapshot instead" nudge.
const DEFAULT_MAX_REPLAY = 50000

const noopPushPipeline = { onAppend(userId, event, originDeviceId, pushHint) {} }

// Polls ws.bufferedAmount until it drains below thresholdBytes, or the
// socket stops being open (no point waiting on a dead connection — the
// replay loop's next send would be a no-op anyway). Exported standalone so
// the polling logic itself is unit-testable without a real socket.
export async function waitForDrain(ws, thresholdBytes, pollMs = 20) {
  while (ws.readyState === 1 && ws.bufferedAmount > thresholdBytes) {
    await new Promise((r) => setTimeout(r, pollMs))
  }
}

// Heartbeat skip rule, exported standalone so the two conditions are unit-
// testable without a real socket (same reason as waitForDrain above).
//
// Inbound traffic within the interval proves the peer is alive, so an
// actively-chatting client shouldn't also pay for a ping — every heartbeat
// is a full radio wake on a phone.
//
// It proves nothing about the peer *reading*, though, which is why the skip
// also requires an empty outgoing queue. A client that keeps sending small
// frames (an `activity` op costs it nothing) while never draining what we
// send would otherwise renew its own liveness forever, and the replay loop's
// ~2×pingMs stall bound — see the VERIFIED note at its waitForDrain call —
// would never fire, leaving the loop parked with a full backpressure buffer.
// A pong is the only evidence the outbound direction is moving, so a
// backlogged socket is always pinged.
export function shouldSkipPing(ws, now, pingMs) {
  return ws.bufferedAmount === 0 && now - (ws._lastInbound || 0) < pingMs
}

export function attachWs({
  server, db, hub, pingMs = 55000, pushPipeline = noopPushPipeline,
  replayBackpressureBytes = REPLAY_BACKPRESSURE_BYTES, maxReplay = DEFAULT_MAX_REPLAY,
  revocationSweepMs = 60000, toolStreams, rpcMaxBytes = RPC_MAX_BYTES, inviteTtlMs = 1800000,
  broker, spawnFoldersTimeoutMs = 4000, spawnStartTimeoutMs = 30000,
}) {
  // Derived, never raw: the orphan sweep must always outlast a live `start`
  // RPC still in flight (see APPROVED_ORPHAN_TTL_FLOOR_MS's comment).
  const approvedOrphanTtlMs = Math.max(APPROVED_ORPHAN_TTL_FLOOR_MS, spawnStartTimeoutMs * 2)
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_WS_PAYLOAD_BYTES })
  const statusCache = makeStatusCache()
  const vitalsCache = makeVitalsCache()
  // Prepared once, reused for the per-frame revocation recheck below — one
  // cheap SELECT per inbound frame, not a fresh db.prepare() call each time.
  const deviceExistsStmt = db.prepare('SELECT 1 FROM devices WHERE id=?')
  const interval = setInterval(() => {
    const now = Date.now()
    for (const ws of wss.clients) {
      if (shouldSkipPing(ws, now, pingMs)) { ws._alive = true; continue }
      if (ws._alive === false) { ws.terminate(); continue }
      ws._alive = false
      ws.ping()
    }
  }, pingMs)
  // Revocation sweep — the backstop for SILENT listeners. The per-frame
  // recheck (below) only fires on a connection's own next inbound frame, so
  // a revoked device that just listens would otherwise keep receiving live
  // journal broadcasts forever. Every registered connection's device id is
  // compared against the devices table in one query; gone → same error
  // frame + 4001 close as the per-frame path. Enforcement is therefore
  // next-frame or ≤ one sweep interval (60s default), whichever comes
  // first. unref'd — never keeps the process alive on its own.
  const sweep = setInterval(() => {
    // Whole-body guard: this callback now does DB work (expireInvites below
    // plus a per-expired-row lookup) ahead of the connection-count
    // early-return, so any SQLite error here (a shutdown race, SQLITE_BUSY)
    // must not become an uncaught exception on the process's timer thread —
    // that would kill the whole server. A reproduced suite flake ("database
    // connection is not open" surfacing well after a test's server had
    // closed) traced to exactly this gap. Fail loud, not fatal.
    try {
      // Tool-stream idle sweep piggybacks on this timer: a bridge that died
      // mid-command never finalizes, so its buffer must expire and any viewer
      // must learn the stream is dead. Runs before the early-return below —
      // buffers expire even when no connection is registered.
      for (const ev of toolStreams.sweepIdle()) notifyStale(hub, ev)
      // Invite expiry (spec: 30 min default, generous because busy is
      // reported honestly via the ack). Piggybacks on this sweep timer, same
      // as the tool-stream idle sweep above. The initiator (room owner for
      // invites, the joiner for join requests) hears an expiry exactly like
      // a refusal, with reason 'expired'; if it is offline right now it
      // simply misses the frame — its next roster/answer attempt tells the
      // same story (conflict / state=expired). Statement prepared once per
      // tick, not once per expired row — expiry is rare but a busy sweep
      // tick could still carry several rows.
      const expired = expireInvites(db, inviteTtlMs)
      const ownerLookup = db.prepare('SELECT owner_user_id FROM conversations WHERE id=?')
      for (const row of expired) {
        const convo = ownerLookup.get(row.convo_id)
        if (!convo) continue
        hub.sendToDevice(convo.owner_user_id, row.initiator_device_id, {
          kind: 'invite', event: 'answer', room_id: row.convo_id,
          peer_device_id: row.agent_device_id, accept: false, reason: 'expired',
        })
      }
      // Catch-all delivery attempt (spec: single pump, three callers) — an
      // admin-approved or HTTP-approved row whose target was already
      // connected by the time it got approved has no hello to catch it;
      // this sweep tick is what finally gets it there.
      deliverPendingInvites(db, hub)
      // awaiting_user TTL (24h, AWAITING_USER_TTL_MS): a parked ask the user
      // never answered at all. Told to the requester as reason: 'refused',
      // NEVER 'expired' — a user-side timeout that never even reached a
      // decision must be indistinguishable from a deliberate no, or a peer
      // could infer "the user hasn't looked yet" and keep re-asking.
      for (const row of expireAwaiting(db, AWAITING_USER_TTL_MS)) {
        const convo = ownerLookup.get(row.convo_id)
        if (!convo) continue
        hub.sendToDevice(convo.owner_user_id, row.initiator_device_id, {
          kind: 'invite', event: 'answer', room_id: row.convo_id,
          peer_device_id: row.agent_device_id, accept: false, reason: 'refused',
        })
      }
      // Spawn-ask TTL — same 24h clock as chat's parked asks and the same
      // sweep tick. Unlike chat's masking ('refused', never 'expired'),
      // spawn asks report expiry honestly: spawn denials are already told
      // plainly as 'declined' (there is no peer to hide behind), so
      // distinguishing "the user never answered" from "the user said no"
      // reveals nothing the parent doesn't already learn from a denial.
      // The cap (countPendingAsks) is what stops a re-ask loop, not
      // ambiguity. Rows carry their own user/device ids — no lookups.
      for (const row of expireSpawns(db, AWAITING_USER_TTL_MS)) {
        hub.sendToDevice(row.user_id, row.from_device_id, {
          kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'expired',
        })
      }
      // Stranded-'approved' recovery (see spawns.js expireApproved's doc
      // comment): a row a claimApprove won but whose orchestration never
      // settled — a restart in the gap before approveSpawn resolves it, or a
      // throw inside approveSpawn that its own catch only logs. Reported to
      // the parent as a plain failure, distinct code so it's diagnosable —
      // this is the one outcome a healthy orchestration never produces
      // itself.
      for (const row of expireApproved(db, approvedOrphanTtlMs)) {
        // A room_id on the row means the orchestration got as far as
        // creating the room before it was orphaned (approveSpawn persists
        // the linkage before issuing `start`) — give that room the same
        // epitaph a live failure writes, so the user isn't left with an
        // unexplained dead room. Best-effort, exactly like fail()'s: the
        // outcome frame below is the one thing this tail cannot skip.
        if (row.room_id) {
          try {
            appendAndBroadcast(db, hub, {
              userId: row.user_id, convoId: row.room_id, sender: 'journal', type: 'text',
              payload: { body: '❌ spawn failed — orphaned. This room\'s child session never started.' },
            })
          } catch (err) {
            console.error('orphan sweep: epitaph write failed', err)
          }
        }
        hub.sendToDevice(row.user_id, row.from_device_id, {
          kind: 'spawn', event: 'outcome', request_id: row.id, outcome: 'failed', error_code: 'orphaned',
        })
      }
      const conns = hub.allConns()
      if (conns.length === 0) return
      const ids = [...new Set(conns.map((c) => c.deviceId))]
      const existing = new Set(
        db.prepare(`SELECT id FROM devices WHERE id IN (${ids.map(() => '?').join(',')})`)
          .all(...ids).map((r) => r.id)
      )
      for (const c of conns) {
        if (existing.has(c.deviceId)) continue
        if (c.ws.readyState !== 1) continue // already closing; its 'close' handler unregisters it
        c.ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'revoked' }))
        c.ws.close(4001)
      }
    } catch (err) {
      console.error('sweep failed', err)
    }
  }, revocationSweepMs)
  sweep.unref()
  wss.on('close', () => { clearInterval(interval); clearInterval(sweep) })

  wss.on('connection', (ws) => {
    ws._alive = true
    ws.on('pong', () => { ws._alive = true })
    // Without a listener, a protocol-level error (e.g. a frame over
    // maxPayload, a bad opcode, invalid UTF-8) makes 'ws' emit 'error' on
    // this socket; an unhandled 'error' event is a Node EventEmitter throw,
    // which would otherwise crash the process. Fails-closed: terminate just
    // this connection instead (the WS library has typically already started
    // tearing the socket down by the time this fires).
    ws.on('error', () => { ws.terminate() })
    let conn = null

    ws.on('message', async (data) => {
      ws._lastInbound = Date.now()
      let msg = null
      try { msg = JSON.parse(data) } catch { /* handled below */ }
      if (!msg || typeof msg !== 'object') {
        // Malformed or non-object frame (e.g. literal `null`, a bare number, or invalid
        // JSON). Pre-auth this is fatal — close the unauthenticated socket rather than
        // leaving it open forever. Post-auth we just ignore it and keep the connection.
        if (!conn) ws.close()
        return
      }
      try {
        if (!conn) {
          if (msg.op !== 'hello') { ws.close(); return }
          const who = msg.token && authToken(db, msg.token)
          if (!who) {
            ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'auth' }))
            ws.close()
            return
          }
          // Same shape as ack's own cursor validation below (`!Number.isInteger(msg.cursor)
          // || msg.cursor < 0`) — a negative cursor is exactly as invalid here as a
          // non-integer one; without this, a negative `msg.cursor` sails through as a
          // "valid" replay start point (headSeq - negativeCursor is even LARGER than the
          // real gap, so it'd either wrongly trip snapshot_required or, for a small
          // negative value, attempt an eventsAfter() scan with a bogus lower bound).
          if (msg.cursor !== undefined && msg.cursor !== null && (!Number.isInteger(msg.cursor) || msg.cursor < 0)) {
            ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'bad_request', ref: 'hello' }))
            ws.close()
            return
          }
          // Optional bridge assertion of its own visibility flag (spec:
          // agent visibility & privacy — MATRON_AGENT_PRIVATE, bridge-side).
          // Same reject shape as a bad cursor: a malformed hello dies here.
          if (msg.private !== undefined && typeof msg.private !== 'boolean') {
            ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'bad_request', ref: 'hello' }))
            ws.close()
            return
          }
          // Agents only — a client has no visibility flag to assert, and
          // silently ignoring it beats closing a working app's socket over a
          // field it should never send. Applied BEFORE replay/registration so
          // every read this connection triggers already sees the new state.
          // Absent field = asserts visible: an unpinned flag follows the env
          // var exactly, including its removal (admin pin is the override).
          if (who.kind === 'agent') applyBridgePrivate(db, who.deviceId, msg.private === true)
          // conn is assigned here, before replay/registration complete below. If another
          // message arrives while the replay loop is yielded (see setImmediate below),
          // it will be dispatched to handleOp before hub.register(conn) runs. That's safe
          // for every op handled today: any journal append it triggers gets a seq greater
          // than the in-flight cursor, so it's picked up by a later replay batch rather
          // than lost. Revisit this assumption if a future op has other side effects.
          conn = { ws, ...who, viewingConvoId: null }
          conn.username = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId).name
          const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(who.userId)
          const headSeq = head ? head.seq : 0
          // device_id/name: the connection's own identity, echoed back so the
          // peer knows who it authenticated as — bridges need it for agent-chat
          // rooms (own-echo guard, roster self-exclusion, room titles); the
          // token is otherwise opaque to them. Reuses the row authToken already
          // resolved (`who`) — no extra lookup.
          ws.send(JSON.stringify({ kind: 'control', op: 'hello_ok', seq: headSeq, device_id: who.deviceId, name: who.name }))
          if (msg.cursor != null) {
            // snapshot_required valve (spec §6): a gap this large is not worth
            // replaying — tell the client to wipe, GET /snapshot, and reconnect
            // with the fresh cursor instead. Close 4009 right after; the socket
            // is never registered (no live traffic for this abandoned attempt).
            if (headSeq - msg.cursor > maxReplay) {
              ws.send(JSON.stringify({ kind: 'control', op: 'snapshot_required' }))
              ws.close(4009)
              return
            }
            let cursor = msg.cursor
            // Agent connections replay only frames for conversations they
            // manage or have joined — the same scoping hub.broadcastJournal
            // applies to live traffic (NULL owner = legacy broadcast).
            // Decision cached per convo for the duration of this replay;
            // membership changing mid-replay is indistinguishable from it
            // changing right after and is harmless.
            const decisionCache = who.kind === 'agent' ? new Map() : null
            const replaysTo = (convoId) => {
              let d = decisionCache.get(convoId)
              if (d === undefined) {
                const owner = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id ?? null
                d = owner == null || owner === who.deviceId
                  || !!db.prepare("SELECT 1 FROM convo_agents WHERE convo_id=? AND agent_device_id=? AND state='joined'").get(convoId, who.deviceId)
                decisionCache.set(convoId, d)
              }
              return d
            }
            for (;;) {
              const batch = eventsAfter(db, who.userId, cursor, 500)
              for (const e of batch) {
                if (decisionCache && !replaysTo(e.convo_id)) continue
                // Client-only events (the agent-chat approval card) never
                // reach an agent device, live or replayed — see
                // isClientOnlyEvent's docstring in journal.js. This is the
                // replay-path half of that guarantee; fanOut below is the
                // live half.
                if (who.kind === 'agent' && isClientOnlyEvent(e.type, e.payload)) continue
                ws.send(JSON.stringify(journalFrame(e)))
              }
              if (batch.length < 500) break
              cursor = batch[batch.length - 1].seq
              // A slow/paused reader must not let the server buffer an unbounded amount
              // of replay data in the socket's outgoing queue — wait for it to drain
              // below the threshold before fetching/sending the next batch.
              //
              // VERIFIED: a reader that never drains at all (not just slow — fully
              // stalled, e.g. the client process stopped reading the socket) is still
              // bounded, by the ping/pong heartbeat above. `wss.clients` is populated by
              // the `ws` library at handshake time (websocket-server.js), before our
              // 'connection' handler even runs — so this socket is already a member of
              // the heartbeat sweep despite not yet being `hub.register()`ed. If no pong
              // arrives within two ping intervals (worst case ~2×pingMs), the sweep calls
              // `ws.terminate()`, which sets `readyState = CLOSING` *synchronously*
              // (websocket.js) regardless of whatever is stuck in the OS socket buffer —
              // so `waitForDrain`'s `ws.readyState === 1` check fails on its very next
              // poll, this loop's `conn.closed` check (a few lines down) returns shortly
              // after, and the replay never has to be resumed. No separate bounded-stall
              // timer or test needed here — it would just be re-testing the heartbeat.
              // The heartbeat's inbound-traffic skip does NOT weaken this: `shouldSkipPing`
              // refuses to skip while anything is queued outbound, which is exactly the
              // state a socket parked here is in.
              await waitForDrain(ws, replayBackpressureBytes)
              // Yield between batches only — a large backlog must not block the event
              // loop (and starve other connections' pings) while replaying.
              await new Promise((r) => setImmediate(r))
              // The socket may have closed while we were awaiting above; its 'close'
              // handler already ran (unregister was a pre-registration no-op), so
              // finishing the replay and registering would insert a permanently-dead
              // conn into the hub that nothing ever prunes. Bail out instead.
              if (conn.closed) return
            }
          }
          // INVARIANT (live-event gap): no yield between the final eventsAfter call (the
          // batch that broke the loop above, batch.length < 500) and hub.register(conn).
          // That synchronous tail is what guarantees no live event can slip through the
          // gap between the end of replay and live registration.
          // INVARIANT (no dead registrations): a closed socket must never remain
          // registered — 'close' can fire during the replay awaits, before registration,
          // making its hub.unregister a no-op; the conn.closed re-check here (and inside
          // the loop above) closes that window. Both checks are synchronous with
          // register, so 'close' cannot interleave between check and register.
          if (conn.closed) return
          hub.register(conn)
          conn.registered = true
          // Host-vitals paint-on-connect: a fresh client gets the last host
          // sample immediately. host_vitals is host-global and never
          // journaled, so it is not part of the cursor replay above — without
          // this a reconnecting client would show a blank vitals gauge until
          // the bridge's next ~5s tick.
          if (conn.kind === 'client') {
            const cachedVitals = vitalsCache.get(conn.userId)
            if (cachedVitals) {
              ws.send(JSON.stringify({ kind: 'ephemeral', host_vitals: cachedVitals }))
            }
          }
          // Catch-up delivery for THIS device only (spec: single pump, three
          // callers) — an invite approved while this agent was offline sits
          // undelivered until it next connects; this is that moment. Scoped
          // to agent connections: a client device is never a recipient row.
          if (who.kind === 'agent') deliverPendingInvites(db, hub, { deviceId: conn.deviceId })
          return
        }
        // Spec §8 close-on-next-frame: revocation is just deleting the
        // devices row (matron-admin device revoke); this is the socket-side
        // half — every frame AFTER hello re-checks that row still exists
        // (hello itself already does the equivalent check via authToken's
        // token-hash lookup, so this must only run post-hello or a revoked
        // token's hello would get checked twice for no benefit).
        if (!deviceExistsStmt.get(conn.deviceId)) {
          conn.ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'revoked' }))
          conn.ws.close(4001)
          return
        }
        // frameBytes = the inbound frame's size as received on the wire —
        // the RPC ops cap THAT (spec: whole inbound frame <= 16 KiB), not a
        // reserialization, which JSON.parse's whitespace-stripping would
        // shrink. `data` is a Buffer here (ws delivers text frames as
        // Buffers), so .length is the byte count.
        await handleOp({ db, hub, conn, msg, pushPipeline, toolStreams, statusCache, vitalsCache, rpcMaxBytes, frameBytes: data.length, broker, spawnFoldersTimeoutMs })
      } catch (err) {
        // Process-crash backstop: handleOp already has its own try/catch for authz
        // errors, so anything reaching here is unexpected. Never let it take the
        // process down. Exceptions before registration (e.g. during replay) close the
        // socket (clients resume from their cursor by design); after registration they
        // send an error-frame and keep the connection.
        if (!conn || !conn.registered) {
          ws.close()
        } else {
          ws.send(JSON.stringify({ kind: 'control', op: 'error', code: 'internal', ref: msg && msg.op, ...roomIdEcho(msg) }))
        }
      }
    })

    ws.on('close', () => {
      if (!conn) return
      // Mark first, then unregister: if this fires mid-replay (before
      // registration), unregister is a no-op and the flag is what stops the
      // replay path from registering a dead conn afterwards.
      conn.closed = true
      hub.unregister(conn)
      // Producer-disconnect teardown (the THIRD tool-stream teardown trigger,
      // alongside explicit `finalize` and the 30-min idle sweep): a producer
      // that dies mid-command never finalizes, stranding its live buffers as a
      // "Running …" overlay until the idle sweep clears it up to 30 min later.
      // Cascade-close exactly the streams THIS connection opened and emit the
      // terminal `end{disconnected}` frame the web client already understands.
      // Scoped to this producer only (closeForProducer keys on the conn), so
      // other producers' streams are untouched; a producer with no open
      // streams is a clean no-op; a stream already finalized/swept is gone from
      // the store and can't double-emit. Only agent connections ever open
      // buffers, so a client close returns [] harmlessly.
      for (const ev of toolStreams.closeForProducer(conn)) {
        notifyStale(hub, ev, 'disconnected')
      }
    })
  })
  return wss
}

// A buffer freed WITHOUT a durable completion event (idle sweep, count-cap
// eviction, or producer disconnect) — tell anyone watching so the client
// doesn't render a live terminal forever. Normal completion needs no
// ephemeral: the finalized tool_output journal frame retires the overlay by
// message_ref. `reason` distinguishes the teardown trigger for the client
// ('stale' = idle sweep/eviction, 'disconnected' = producer connection drop);
// the client treats any `end` frame as terminal regardless.
export function notifyStale(hub, entry, reason = 'stale') {
  hub.sendEphemeral(entry.userId, entry.convoId, {
    kind: 'ephemeral', convo_id: entry.convoId, message_ref: entry.ref,
    tool_stream: { event: 'end', reason },
  })
}

// Extended by Tasks 7-8 with client and agent operations.
export async function handleOp({ db, hub, conn, msg, pushPipeline = noopPushPipeline, toolStreams, statusCache = makeStatusCache(), vitalsCache = makeVitalsCache(), rpcMaxBytes = RPC_MAX_BYTES, frameBytes = 0, broker, spawnFoldersTimeoutMs = 4000 }) {
  const fail = (code, detail) => {
    conn.ws.send(JSON.stringify({
      kind: 'control', op: 'error', code, ref: msg.op,
      ...roomIdEcho(msg), ...(detail ? { detail } : {}),
    }))
  }
  // Invite ops: validate a room id + load the row. Rooms are top-level
  // conversations of this conn's user; children (sub-chats) are silenced
  // conversations and can never be rooms.
  const loadRoom = (roomId) => {
    if (typeof roomId !== 'string' || !roomId || roomId.length > CONVO_ID_MAX_CHARS) return { err: ['bad_request', 'bad room_id'] }
    const room = db.prepare('SELECT owner_user_id, agent_device_id, parent_convo_id FROM conversations WHERE id=?').get(roomId)
    if (!room || room.owner_user_id !== conn.userId) return { err: ['not_found'] }
    // Privacy gate — single choke point (spec: agent visibility & privacy).
    // A room owned by a private device does not exist for an ordinary
    // caller with no standing footing in it: every other loadRoom-gated op
    // (agent_invite's "only the owner may invite", agent_join's owner-null/
    // self checks, agent_invite_ack/_answer's "no pending invite",
    // agent_leave's "not a joined participant", and the child-convo check
    // right below) would otherwise answer differently for a private-owned
    // room than for an unknown one — an existence oracle one caller-
    // controlled field away. Must run before ALL of those, including the
    // child-convo check. The exemption is `isKnownParticipant`, NOT plain
    // isParticipant — a row the caller only knows about because THEY
    // legitimately initiated it, or that was actually delivered to them, or
    // where they're joined. A merely parked ('awaiting_user', never
    // relayed) or denied (never told) row must not exempt the gate — either
    // would leak a private room's existence to an agent the user never
    // approved or explicitly refused. See isKnownParticipant's doc comment
    // for the 'expired' ambiguity this also resolves.
    if (room.agent_device_id != null && isPrivateDevice(db, room.agent_device_id)
      && !isPrivateDevice(db, conn.deviceId) && !isKnownParticipant(db, roomId, conn.deviceId)) {
      return { err: ['not_found'] }
    }
    if (room.parent_convo_id != null) return { err: ['bad_request', 'child conversations cannot be rooms'] }
    return { room }
  }
  // Single choke point: every journal event becomes a WS frame AND (fire and
  // forget) a candidate push, right here — nowhere else calls
  // hub.broadcastJournal for a freshly-appended event. The push pipeline runs
  // strictly after the append+broadcast have succeeded, so a failure inside
  // it is a server-side delivery concern only — swallow and log rather than
  // letting it bubble up and surface as a spurious {op:'error'} frame for an
  // op that, from the client's perspective, already succeeded.
  // `pushHint` is an in-memory-only extra for the push pipeline (e.g.
  // session_status's prevSessionState, for turn-finished detection in
  // push.js classify()) — it never touches the frame, so it can't leak onto
  // the wire or into the stored event payload.
  const fanOut = (frame, pushHint) => {
    // Delivery targets: recorded owner + joined participants (spec: agent
    // chat phase 2 room fan-out). null owner = legacy broadcast. The convo
    // row is already hot from append()'s own authorization read; the
    // participant lookup is a primary-key-prefix seek on convo_agents.
    const ownerId = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(frame.convo_id)?.agent_device_id ?? null
    // Client-only events (the agent-chat approval card) skip every agent
    // device, including the room's own recorded owner — an empty Set here
    // is deliberately NOT the same as the null "legacy broadcast" case
    // below: broadcastJournal treats null as "no agent filtering at all"
    // and an empty Set as "every agent kind connection is excluded".
    const targets = isClientOnlyEvent(frame.type, frame.payload)
      ? new Set()
      : (ownerId == null ? null : new Set([ownerId, ...joinedAgentIds(db, frame.convo_id)]))
    // Live frames carry the producing connection's device id: device names
    // have no unique constraint, so a bridge in a shared room can't reliably
    // tell its own echoes apart by sender name alone. Deliberately LIVE-only
    // — absent from hello replay (journalFrame over eventsAfter) and never
    // stored in the event row, so consumers must fall back to sender-name
    // matching for replayed history.
    frame.sender_device_id = conn.deviceId
    hub.broadcastJournal(conn.userId, frame, targets)
    try {
      pushPipeline.onAppend(conn.userId, frame, conn.deviceId, pushHint)
    } catch (err) {
      console.error('push pipeline onAppend failed (append/broadcast already succeeded)', err)
    }
  }
  const appendAndFan = (args) => {
    const r = append(db, args)
    if (!r.duplicate) {
      fanOut(journalFrame({
        seq: r.seq, convo_id: args.convoId, ts: r.ts,
        sender: args.sender, type: args.type, payload: args.payload,
      }), args.pushHint)
    }
    return r
  }
  // Sub-chats (child convos, parent_convo_id set) mirror a subagent's transcript
  // for durability and are READ-ONLY to clients: a user write injects an orphan
  // message no session is reading, and a send can race a mid-upload media
  // reclassification. The client hides the composer, but
  // an old tab or a direct WS caller could still reach a client-write op — this
  // is the authoritative guard, applied to EVERY client write path (send,
  // prompt_reply). Scoped to the sender's own user; a missing/foreign convo (row
  // null) is NOT treated as a child here, so it still falls through to append()'s
  // own not-authorized throw, preserving the foreign-convo anti-enumeration path.
  // Agents keep writing children freely via publish/convo_upsert.
  const isReadOnlyChild = (convoId) => {
    const row = db.prepare('SELECT parent_convo_id FROM conversations WHERE id=? AND owner_user_id=?').get(convoId, conn.userId)
    return !!row && row.parent_convo_id != null
  }
  try {
    switch (msg.op) {
      case 'viewing': {
        conn.viewingConvoId = msg.convo_id ?? null
        // Catch-up for live tool-output streams: whoever just started viewing
        // gets full scrollback-so-far, one sync frame per active buffer, sent
        // directly (not via hub coalescing) and synchronously — no append can
        // interleave before these because this `viewing` case body is entirely
        // synchronous (no `await`), start to finish, in one event-loop turn.
        // NOT a property of handleOp as a whole any more — spawn_targets
        // awaits mid-handler, so a message dispatched to that case can
        // interleave with other work between its awaits. Scoped to the conn's
        // own user; buffersFor enforces it too.
        if (conn.viewingConvoId && conn.kind === 'client') {
          for (const b of toolStreams.buffersFor(conn.userId, conn.viewingConvoId)) {
            conn.ws.send(JSON.stringify({
              kind: 'ephemeral', convo_id: conn.viewingConvoId, message_ref: b.ref,
              tool_stream: {
                event: 'sync', meta: b.meta, offset: b.start,
                content: b.content, head_truncated: b.headTruncated,
              },
            }))
          }
          // Header catch-up: replay the last cached status (same direct-send
          // reasoning as the tool-stream syncs above) so the header populates
          // on open instead of waiting for the next turn end.
          const cachedStatus = statusCache.get(conn.userId, conn.viewingConvoId)
          if (cachedStatus) {
            conn.ws.send(JSON.stringify({
              kind: 'ephemeral', convo_id: conn.viewingConvoId, status: cachedStatus,
            }))
          }
        }
        break
      }
      case 'ack':
        if (!Number.isInteger(msg.cursor) || msg.cursor < 0) return fail('bad_request')
        db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(msg.cursor, conn.deviceId)
        break
      case 'send': {
        if (conn.kind !== 'client') return fail('forbidden')
        const type = msg.type || 'text'
        if (!CLIENT_SEND_TYPES.has(type)) return fail('forbidden')
        if (typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        // Media sends are useless without a blob to fetch — reject early
        // instead of appending a row no consumer can resolve.
        if (type !== 'text' && (typeof msg.blob_ref !== 'string' || msg.blob_ref.length === 0)) {
          return fail('bad_request', 'media send requires blob_ref')
        }
        // Read-only sub-chat guard (see isReadOnlyChild above).
        if (isReadOnlyChild(msg.convo_id)) return fail('forbidden', 'sub-chat is read-only')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type,
          payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: msg.local_id ? `client:${conn.deviceId}:${msg.local_id}` : null,
        })
        break
      }
      case 'prompt_reply': {
        if (conn.kind !== 'client') return fail('forbidden')
        if (!Number.isInteger(msg.target_seq)) return fail('bad_request')
        // Read-only sub-chat guard (see isReadOnlyChild above).
        if (isReadOnlyChild(msg.convo_id)) return fail('forbidden', 'sub-chat is read-only')
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `user:${conn.username}`, type: 'prompt_reply',
          payload: { target_seq: msg.target_seq, choice: msg.choice ?? null, text: msg.text ?? null },
        })
        break
      }
      case 'agent_request': {
        if (conn.kind !== 'client') return fail('forbidden')
        const rid = msg.request_id
        // request_id is echoed on every correlated frame, so it validates
        // first — errors after this point can carry it.
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        const failRpc = (code, detail) => conn.ws.send(JSON.stringify(
          { kind: 'control', op: 'error', code, ref: msg.op, request_id: rid, ...(detail ? { detail } : {}) }))
        // Ops are dispatched during this connection's own hello replay,
        // BEFORE hub.register (see the hello handler's comment: "revisit
        // this assumption if a future op has other side effects" — this is
        // that op). A request accepted mid-replay would forward fine, but
        // the response's hub scan couldn't see this unregistered socket and
        // the reply would silently vanish — inviting a timeout-retry of a
        // non-idempotent `start`. Reject instead: nothing forwarded, so a
        // verbatim re-send after replay is always safe.
        if (!conn.registered) return failRpc('not_ready')
        if (typeof msg.method !== 'string' || msg.method.length === 0 || msg.method.length > RPC_NAME_MAX_CHARS) return failRpc('bad_request', 'bad method')
        if (!Number.isInteger(msg.agent_device_id)) return failRpc('bad_request', 'bad agent_device_id')
        // Wire-byte cap (spec: whole inbound frame <= 16 KiB as received) —
        // measured on the raw payload, not a reserialization that
        // JSON.parse's whitespace-stripping would shrink.
        if (frameBytes > rpcMaxBytes) return failRpc('bad_request', 'frame too large')
        // Serializability guard (status-op precedent): a deeply nested
        // params/result would overflow JSON.stringify's call stack at
        // delivery — surface it as a correlated bad_request here instead of
        // an uncorrelated internal error there.
        try { JSON.stringify(msg) } catch { return failRpc('bad_request', 'unserializable frame') }
        // Unknown id, another user's device, and a client-kind device are
        // indistinguishable — anti-enumeration, same stance as the HTTP 404s.
        const target = db.prepare('SELECT user_id, kind FROM devices WHERE id=?').get(msg.agent_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'agent') return failRpc('not_found')
        // Single-consumer delivery (see hub.sendRpcRequest): false means no
        // live socket — no queueing, the client hears it immediately.
        const delivered = hub.sendRpcRequest(conn.userId, msg.agent_device_id, {
          kind: 'rpc',
          request: { request_id: rid, from_device_id: conn.deviceId, method: msg.method, params: msg.params ?? null },
        })
        if (!delivered) return failRpc('agent_unreachable')
        break
      }
      case 'agent_response': {
        if (conn.kind !== 'agent') return fail('forbidden')
        const rid = msg.request_id
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        const failRpc = (code, detail) => conn.ws.send(JSON.stringify(
          { kind: 'control', op: 'error', code, ref: msg.op, request_id: rid, ...(detail ? { detail } : {}) }))
        if (typeof msg.ok !== 'boolean') return failRpc('bad_request', 'bad ok')
        if (!Number.isInteger(msg.to_device_id)) return failRpc('bad_request', 'bad to_device_id')
        // The only payload shape rule the server enforces: a failure must
        // carry a machine-usable code. Everything else is bridge-owned.
        if (!msg.ok && (typeof msg.error !== 'object' || msg.error === null
            || typeof msg.error.code !== 'string' || msg.error.code.length === 0
            || msg.error.code.length > RPC_NAME_MAX_CHARS)) {
          return failRpc('bad_request', 'error.code required when ok is false')
        }
        // Wire-byte cap (spec: whole inbound frame <= 16 KiB as received) —
        // measured on the raw payload, not a reserialization that
        // JSON.parse's whitespace-stripping would shrink.
        if (frameBytes > rpcMaxBytes) return failRpc('bad_request', 'frame too large')
        // Serializability guard (status-op precedent): a deeply nested
        // params/result would overflow JSON.stringify's call stack at
        // delivery — surface it as a correlated bad_request here instead of
        // an uncorrelated internal error there.
        try { JSON.stringify(msg) } catch { return failRpc('bad_request', 'unserializable frame') }
        // Journal-originated requests (spawn brokering, folder discovery)
        // resolve internally instead of being forwarded — the broker checks
        // that THIS device, on THIS user, is the one the request went to.
        // Unmatched replies fall through to the client-forward path below,
        // where to_device_id 0 lands in the same not_found every unknown
        // device gets.
        if (broker && broker.resolve(rid, { userId: conn.userId, deviceId: conn.deviceId, msg })) break
        const target = db.prepare('SELECT user_id, kind FROM devices WHERE id=?').get(msg.to_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'client') return failRpc('not_found')
        // Multicast (see hub.sendRpcResponse); a fully disconnected client
        // just misses it — stateless relay, the app re-asks.
        hub.sendRpcResponse(conn.userId, msg.to_device_id, {
          kind: 'rpc',
          response: {
            request_id: rid, agent_device_id: conn.deviceId, ok: msg.ok,
            ...(msg.ok
              ? { result: msg.result ?? null }
              : { error: { code: msg.error.code, ...(typeof msg.error.detail === 'string' ? { detail: msg.error.detail } : {}) } }),
          },
        })
        break
      }
      case 'spawn_request': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const rid = msg.request_id
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        if (typeof msg.workdir !== 'string' || !msg.workdir || msg.workdir.length > SPAWN_WORKDIR_MAX_CHARS) return fail('bad_request', 'bad workdir')
        if (typeof msg.task !== 'string' || !msg.task || msg.task.length > SPAWN_TASK_MAX_CHARS) return fail('bad_request', 'bad task')
        if (msg.topic != null && (typeof msg.topic !== 'string' || msg.topic.length > INVITE_TOPIC_MAX_CHARS)) return fail('bad_request', 'bad topic')
        if (!Number.isInteger(msg.target_device_id)) return fail('bad_request', 'bad target_device_id')
        if (msg.target_device_id === conn.deviceId) return fail('bad_request', 'cannot spawn on self')
        // Ownership stance copied from agent_request/agent_invite: unknown
        // id, another user's device, a client device — and a private device
        // seen by an ordinary agent — are indistinguishable not_found.
        const target = db.prepare('SELECT user_id, kind, private, name FROM devices WHERE id=?').get(msg.target_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'agent'
          || (target.private === 1 && !isPrivateDevice(db, conn.deviceId))) return fail('not_found')
        // Which of the parent's own conversations is asking — REQUIRED here
        // (the card and the outcome both land in it), same authorisation
        // shape as agent_invite's from_convo_id.
        if (typeof msg.from_convo_id !== 'string' || !msg.from_convo_id) return fail('bad_request', 'bad from_convo_id')
        const fromConvo = db.prepare(
          'SELECT owner_user_id, agent_device_id, parent_convo_id, title FROM conversations WHERE id=?'
        ).get(msg.from_convo_id)
        if (!fromConvo || fromConvo.owner_user_id !== conn.userId
          || fromConvo.agent_device_id !== conn.deviceId
          || fromConvo.parent_convo_id != null) return fail('not_found')
        // An unreachable box is refused BEFORE any card is published — never
        // spend the user's tap on something that cannot work. Same liveness
        // rule as hub.sendRpcRequest without sending anything.
        const online = hub.connsOf(conn.userId).some((c) => c.deviceId === msg.target_device_id && c.ws.readyState === 1)
        if (!online) return fail('agent_unreachable')
        const workdir = sanitizePeerText(msg.workdir, SPAWN_WORKDIR_MAX_CHARS)
        if (!workdir) return fail('bad_request', 'bad workdir')
        const task = sanitizePeerText(msg.task, SPAWN_TASK_MAX_CHARS)
        if (!task) return fail('bad_request', 'bad task')
        const topic = sanitizePeerText(msg.topic, INVITE_TOPIC_MAX_CHARS)
        // Shared attention throttle — counts chat asks AND spawn asks.
        if (countPendingAsks(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER) {
          return fail('conflict', 'too many requests awaiting user approval')
        }
        const spawnId = randomUUID()
        createSpawnRequest(db, {
          id: spawnId, userId: conn.userId, fromDeviceId: conn.deviceId,
          fromConvoId: msg.from_convo_id, targetDeviceId: msg.target_device_id,
          workdir, task, topic,
        })
        // Client-only card (isClientOnlyEvent covers kind:'agent_spawn'),
        // published into the PARENT's own conversation — where the user is
        // already talking to the agent that is asking. The row was inserted
        // FIRST (the card must carry a real request_id) — so an append
        // failure must take the row back out, or a phantom awaiting_user
        // row squats on the shared pending cap for 24h with no card the
        // user could ever answer. Append and broadcast are deliberately
        // SPLIT here (not appendAndFan): the durable append is the commit
        // point that decides row-vs-discard — discarding after a mere
        // broadcast failure would orphan an already-journaled card whose
        // request_id no longer resolves. A broadcast failure after the
        // append is a delivery concern only (same stance as fanOut's own
        // push tail): row and card both exist, clients catch up at their
        // next snapshot.
        const cardSender = `agent:${conn.name}`
        const cardPayload = {
          kind: 'agent_spawn', request_id: spawnId,
          from_device_id: conn.deviceId, from_name: sanitizePeerText(conn.name, PEER_NAME_CAP),
          from_convo_id: msg.from_convo_id,
          from_convo_title: sanitizePeerText(fromConvo.title, CARD_TITLE_MAX_CHARS),
          target_device_id: msg.target_device_id, target_name: sanitizePeerText(target.name, PEER_NAME_CAP),
          workdir, task, topic,
        }
        let cardAppend
        try {
          cardAppend = append(db, { userId: conn.userId, convoId: msg.from_convo_id, sender: cardSender, type: 'permission_request', payload: cardPayload })
        } catch (err) {
          console.error('spawn_request: card append failed, discarding row', err)
          discardSpawnRequest(db, spawnId)
          return fail('internal', 'card publish failed')
        }
        if (!cardAppend.duplicate) {
          try {
            fanOut(journalFrame({
              seq: cardAppend.seq, convo_id: msg.from_convo_id, ts: cardAppend.ts,
              sender: cardSender, type: 'permission_request', payload: cardPayload,
            }))
          } catch (err) {
            console.error('spawn_request: card broadcast failed (card is journaled; clients catch up via snapshot)', err)
          }
        }
        conn.ws.send(JSON.stringify({ kind: 'spawn', event: 'pending', request_id: rid, spawn_id: spawnId }))
        break
      }
      case 'spawn_targets': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const rid = msg.request_id
        if (typeof rid !== 'string' || rid.length === 0 || rid.length > RPC_ID_MAX_CHARS) return fail('bad_request', 'bad request_id')
        // Single-flight per connection: every spawn_targets frame fans one
        // recent_folders RPC out to EVERY online box and holds up to
        // spawnFoldersTimeoutMs for each — without this, a looping agent
        // could stack unbounded concurrent fan-outs on one socket and spam
        // every box the user owns. One in flight is all discovery ever
        // needs; a second concurrent ask is a caller bug, told as the same
        // 'conflict' the pending-ask cap uses.
        if (conn.spawnTargetsInflight) return fail('conflict', 'spawn_targets already in flight')
        conn.spawnTargetsInflight = true
        // Same visibility rule as the roster: self excluded (a self-entry is
        // a self-spawn trap), private boxes hidden from ordinary agents.
        const callerPrivate = isPrivateDevice(db, conn.deviceId)
        const boxes = db.prepare(
          "SELECT id AS device_id, name, private FROM devices WHERE user_id=? AND kind='agent' AND id!=?"
        ).all(conn.userId, conn.deviceId)
          .filter((d) => callerPrivate || d.private !== 1)
        const live = new Set(hub.connsOf(conn.userId).filter((c) => c.ws.readyState === 1).map((c) => c.deviceId))
        // Folder discovery rides the broker (spec: "once it exists, folder
        // discovery rides it for free"). Offline boxes are listed with no
        // folders and no RPC; a box that fails or times out degrades to []
        // — discovery must never error because one box is sick.
        try {
          const out = await Promise.all(boxes.map(async (d) => {
            const online = live.has(d.device_id)
            let folders = []
            let activity = null
            let limits = null
            if (online) {
              const r = await broker.issue(hub, conn.userId, d.device_id, 'recent_folders', null, { timeoutMs: spawnFoldersTimeoutMs })
              if (r.ok && Array.isArray(r.result?.folders)) folders = r.result.folders
              if (r.ok) {
                // Optional capacity blocks (2026-08-10 bridge capacity spec): validated
                // all-or-nothing; a bridge that predates them just lists folders.
                activity = sanitizeSpawnActivity(r.result?.activity)
                limits = sanitizeSpawnLimits(r.result?.limits)
              }
            }
            // Sanitised like every other client-bound device name (roster,
            // consent cards) — the recipient here is an agent, not a client, so
            // this is cheap insurance rather than closing a real hole.
            return {
              device_id: d.device_id, name: sanitizePeerText(d.name, PEER_NAME_CAP), online, folders,
              ...(activity ? { activity } : {}),
              ...(limits ? { limits } : {}),
            }
          }))
          conn.ws.send(JSON.stringify({ kind: 'spawn', event: 'targets', request_id: rid, boxes: out }))
        } finally {
          conn.spawnTargetsInflight = false
        }
        break
      }
      case 'agent_invite': {
        if (conn.kind !== 'agent') return fail('forbidden')
        // Replies (delivered/ack/answer) are found by a hub scan of this
        // device's sockets — mid-replay this socket is invisible there, so
        // reject like agent_request does rather than lose the reply.
        if (!conn.registered) return fail('not_ready')
        const { room, err } = loadRoom(msg.room_id)
        if (err) return fail(...err)
        if (room.agent_device_id !== conn.deviceId) return fail('forbidden', 'only the room owner may invite')
        if (!Number.isInteger(msg.target_device_id)) return fail('bad_request', 'bad target_device_id')
        if (msg.target_device_id === conn.deviceId) return fail('bad_request', 'cannot invite self')
        if (msg.topic != null && (typeof msg.topic !== 'string' || msg.topic.length > INVITE_TOPIC_MAX_CHARS)) return fail('bad_request', 'bad topic')
        if (typeof msg.justification !== 'string' || !msg.justification || msg.justification.length > INVITE_TEXT_MAX_CHARS) return fail('bad_request', 'bad justification')
        // Unknown id, another user's device, a client device — and now a
        // private device seen by an ORDINARY agent — are indistinguishable
        // (spec: agent visibility & privacy; a distinct error would confirm
        // the existence being hidden). A private CALLER passes: invisible,
        // not blinded.
        const target = db.prepare('SELECT user_id, kind, private, name FROM devices WHERE id=?').get(msg.target_device_id)
        if (!target || target.user_id !== conn.userId || target.kind !== 'agent'
          || (target.private === 1 && !isPrivateDevice(db, conn.deviceId))) return fail('not_found')
        // Which of the target's conversations this ask is FOR (spec: agent
        // chat phase 3.5). Optional — a pre-3.5 bridge sends none — but when
        // present it is authorisation, not a hint: the requester may only
        // address a top-level conversation that the target device actually
        // owns. Without this check a caller could name any convo id and the
        // receiving bridge would bind the room to that session, which is a
        // write into a conversation the requester was never invited to.
        // Every failure is the same 'not_found' the unknown-device case
        // gets: distinguishing "no such convo" from "not that device's"
        // would confirm the existence of conversations the caller cannot see.
        let targetConvoId = null
        let toConvoTitle = ''
        if (msg.target_convo_id != null) {
          if (typeof msg.target_convo_id !== 'string' || !msg.target_convo_id) return fail('bad_request', 'bad target_convo_id')
          const targetConvo = db.prepare(
            'SELECT owner_user_id, agent_device_id, parent_convo_id, title FROM conversations WHERE id=?'
          ).get(msg.target_convo_id)
          if (!targetConvo || targetConvo.owner_user_id !== conn.userId
            || targetConvo.agent_device_id !== msg.target_device_id
            || targetConvo.parent_convo_id != null) return fail('not_found')
          targetConvoId = msg.target_convo_id
          toConvoTitle = sanitizePeerText(targetConvo.title, CARD_TITLE_MAX_CHARS)
        }
        // Which of the REQUESTER's own conversations is doing the asking
        // (spec: agent chat request naming). Same authorisation shape as
        // target_convo_id above, and for the same reason turned around: a
        // title is presented to the user as the asker's identity, so a
        // requester naming a conversation it does not own would be
        // borrowing someone else's name to be trusted by. Optional — a
        // bridge that predates this field sends none and the card simply
        // says less.
        let fromConvoTitle = ''
        if (msg.from_convo_id != null) {
          if (typeof msg.from_convo_id !== 'string' || !msg.from_convo_id) return fail('bad_request', 'bad from_convo_id')
          const fromConvo = db.prepare(
            'SELECT owner_user_id, agent_device_id, parent_convo_id, title FROM conversations WHERE id=?'
          ).get(msg.from_convo_id)
          if (!fromConvo || fromConvo.owner_user_id !== conn.userId
            || fromConvo.agent_device_id !== conn.deviceId
            || fromConvo.parent_convo_id != null) return fail('not_found')
          fromConvoTitle = sanitizePeerText(fromConvo.title, CARD_TITLE_MAX_CHARS)
        }
        const topic = sanitizePeerText(msg.topic, INVITE_TOPIC_MAX_CHARS)
        const justification = sanitizePeerText(msg.justification, INVITE_TEXT_MAX_CHARS)
        // The raw-string check above only catches a literally empty string —
        // a payload of spaces/control chars passes it and THEN sanitises
        // down to '', which would park/relay an invite with an empty
        // justification and publish an empty card body. Re-check post-
        // sanitisation with the same error the empty-string case gets.
        if (!justification) return fail('bad_request', 'bad justification')
        // Every ask parks for the user's consent — there is no standing
        // allowance and no fast path, so nothing reaches the target's socket
        // before a human answers. Capped per requester device so one chatty
        // agent can't flood the user's attention queue with asks. The sum
        // counts both chat asks (convo_agents) and spawn requests.
        if (countPendingAsks(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER) {
          return fail('conflict', 'too many requests awaiting user approval')
        }
        const r = parkInvite(db, { convoId: msg.room_id, agentDeviceId: msg.target_device_id, initiatorDeviceId: conn.deviceId, justification, topic, targetConvoId })
        if (!r.ok) return fail('conflict', `already ${r.state}`)
        // Client-only card (isClientOnlyEvent in journal.js): appendAndFan's
        // own fan-out already excludes every agent device, including the
        // room's recorded owner, so this never reaches an agent socket.
        appendAndFan({
          userId: conn.userId, convoId: msg.room_id, sender: `agent:${conn.name}`, type: 'permission_request',
          payload: {
            kind: 'agent_chat', request: 'invite', room_id: msg.room_id,
            from_device_id: conn.deviceId, from_name: sanitizePeerText(conn.name, PEER_NAME_CAP),
            target_device_id: msg.target_device_id, topic, justification,
            // Display-only identity, alongside the routing ids above: who is
            // asking, and who they want to talk to. Without these a client
            // holds two opaque device ids and can only say "another agent",
            // which is not something a user can consent to. to_name is
            // always resolvable here; the two titles are blank when the
            // bridge named no conversation.
            // The ids travel alongside the titles because a title is
            // mutable, agent-written, and not guaranteed to identify
            // anything: bridges seed session titles with a "<box>:<first two
            // of the id>" prefix, but a room's title has none, a retitle can
            // drop one, and two sessions can end up with the same words. The
            // id is the stable handle a client renders the short form from —
            // and the one it would need to deep-link to the conversation.
            from_convo_id: msg.from_convo_id ?? '',
            from_convo_title: fromConvoTitle,
            to_name: sanitizePeerText(target.name, PEER_NAME_CAP),
            to_convo_id: targetConvoId ?? '',
            to_convo_title: toConvoTitle,
          },
        })
        // Same ack as a relayed request: to the bridge, delivered means
        // "accepted into the system" — its tool copy already says pending is
        // normal and the answer arrives as a later turn. A distinct 'parked'
        // event would let a requester distinguish gated targets from
        // ungated ones.
        conn.ws.send(JSON.stringify({ kind: 'invite', event: 'delivered', room_id: msg.room_id, target_device_id: msg.target_device_id }))
        break
      }
      case 'agent_join': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const { room, err } = loadRoom(msg.room_id)
        if (err) return fail(...err)
        if (typeof msg.justification !== 'string' || !msg.justification || msg.justification.length > INVITE_TEXT_MAX_CHARS) return fail('bad_request', 'bad justification')
        if (room.agent_device_id == null) return fail('conflict', 'room has no recorded owner to ask')
        if (room.agent_device_id === conn.deviceId) return fail('bad_request', 'cannot join own room')
        const justification = sanitizePeerText(msg.justification, INVITE_TEXT_MAX_CHARS)
        // See agent_invite's matching check: the raw-string check above only
        // catches a literally empty string, not whitespace/control chars
        // that sanitise down to ''.
        if (!justification) return fail('bad_request', 'bad justification')
        // Room ownership was established above, so this row exists; `?.name`
        // only guards the device being deleted between the two statements,
        // in which case the card degrades to a nameless owner rather than
        // throwing inside the op handler.
        const ownerName = db.prepare('SELECT name FROM devices WHERE id=?').get(room.agent_device_id)?.name ?? ''
        // Every ask parks for the user's consent — there is no standing
        // allowance and no fast path, so nothing reaches the room owner's
        // socket before a human answers. Capped per requester device so one
        // chatty agent can't flood the user's attention queue with asks. The
        // sum counts both chat asks (convo_agents) and spawn requests.
        if (countPendingAsks(db, conn.deviceId) >= MAX_AWAITING_PER_REQUESTER) {
          return fail('conflict', 'too many requests awaiting user approval')
        }
        const r = parkInvite(db, { convoId: msg.room_id, agentDeviceId: conn.deviceId, initiatorDeviceId: conn.deviceId, justification, topic: '' })
        if (!r.ok) return fail('conflict', `already ${r.state}`)
        appendAndFan({
          userId: conn.userId, convoId: msg.room_id, sender: `agent:${conn.name}`, type: 'permission_request',
          payload: {
            kind: 'agent_chat', request: 'join', room_id: msg.room_id,
            from_device_id: conn.deviceId, from_name: sanitizePeerText(conn.name, PEER_NAME_CAP),
            // The row this card asks about is keyed on the JOINER (parkInvite
            // above passes agentDeviceId: conn.deviceId), and that is exactly
            // what POST /agent-chat/answer looks up. A join self-targets, so
            // this equals from_device_id — the answer endpoint relies on that
            // (`isJoin = row.initiator_device_id === target_device_id`).
            // Sending the room owner here instead would make a client that
            // echoes the card's own field back get a 409: no such row.
            // Not to be confused with the ephemeral `invite/delivered` ack
            // below, whose target_device_id IS the owner — that frame reports
            // who was asked, not which row is pending.
            target_device_id: conn.deviceId, topic: '', justification,
            // Display-only, mirroring the invite card. Note this deliberately
            // does NOT follow target_device_id: that field names the row to
            // answer (the joiner, self-targeted), whereas the user needs to
            // read who is being asked to let them in — the room's owner.
            from_convo_id: '',
            from_convo_title: '',
            to_name: sanitizePeerText(ownerName, PEER_NAME_CAP),
            to_convo_id: '',
            to_convo_title: '',
          },
        })
        conn.ws.send(JSON.stringify({ kind: 'invite', event: 'delivered', room_id: msg.room_id, target_device_id: room.agent_device_id }))
        break
      }
      case 'agent_invite_ack':
      case 'agent_invite_answer': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const { room, err } = loadRoom(msg.room_id)
        if (err) return fail(...err)
        // Direction rule: the row names the non-owner participant;
        // initiator_device_id says who started it; the NON-initiator acks/
        // answers. peer_device_id present = the owner acting on a join
        // request; absent = the participant acting on an owner invite.
        let rowDeviceId
        if (msg.peer_device_id != null) {
          if (!Number.isInteger(msg.peer_device_id)) return fail('bad_request', 'bad peer_device_id')
          if (room.agent_device_id !== conn.deviceId) return fail('forbidden', 'only the room owner answers a join request')
          rowDeviceId = msg.peer_device_id
        } else {
          rowDeviceId = conn.deviceId
        }
        const row = getParticipant(db, msg.room_id, rowDeviceId)
        if (!row || row.state !== 'invited') return fail('conflict', 'no pending invite')
        if (row.initiator_device_id === conn.deviceId) return fail('forbidden', 'the initiator cannot answer its own invite')
        if (msg.op === 'agent_invite_ack') {
          if (!SESSION_ACK_STATES.has(msg.session_state)) return fail('bad_request', 'bad session_state')
          hub.sendToDevice(conn.userId, row.initiator_device_id, {
            kind: 'invite', event: 'ack', room_id: msg.room_id,
            from_device_id: conn.deviceId, session_state: msg.session_state,
          })
          break
        }
        if (typeof msg.accept !== 'boolean') return fail('bad_request', 'bad accept')
        if (msg.reason != null && (typeof msg.reason !== 'string' || msg.reason.length > INVITE_TEXT_MAX_CHARS)) return fail('bad_request', 'bad reason')
        if (!answerInvite(db, { convoId: msg.room_id, agentDeviceId: rowDeviceId, accept: msg.accept })) {
          return fail('conflict', 'no pending invite')
        }
        hub.sendToDevice(conn.userId, row.initiator_device_id, {
          kind: 'invite', event: 'answer', room_id: msg.room_id,
          peer_device_id: rowDeviceId, accept: msg.accept, from_device_id: conn.deviceId,
          ...(typeof msg.reason === 'string' && msg.reason ? { reason: msg.reason } : {}),
        })
        break
      }
      case 'agent_leave': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!conn.registered) return fail('not_ready')
        const { room, err } = loadRoom(msg.room_id)
        if (err) return fail(...err)
        // Best-effort notification: by the time these run the DB flip is
        // already committed, so a throwing send (a socket that died between
        // the hub's lookup and the write) must not surface as {code:
        // 'internal'} — the caller would retry a leave that has already
        // happened, the retry would no-op, and the peers not yet reached
        // would never be told. Swallow and log, same stance as fanOut's
        // push-pipeline guard.
        const notify = (deviceId, frame) => {
          try {
            hub.sendToDevice(conn.userId, deviceId, frame)
          } catch (sendErr) {
            console.error('agent_leave notify failed (the leave itself already committed)', sendErr)
          }
        }
        // Owner leave: the recorded owner has no convo_agents row, so
        // leaveConvo can never represent it — the room dissolves instead.
        // Gated on the convo actually being a ROOM (any convo_agents row,
        // any state): convo_upsert stamps agent_device_id on every
        // agent-created conversation, so without this a plain solo convo
        // that never had a participant would take the dissolve branch and
        // answer a bogus agent_leave with silent success instead of the
        // historical `not a joined participant` conflict below. State-
        // agnostic, so an already-dissolved room (all rows 'left') still
        // takes this branch and stays idempotent.
        if (room.agent_device_id === conn.deviceId && hasParticipants(db, msg.room_id)) {
          const { joined, pending } = leaveAllParticipants(db, msg.room_id)
          // Everyone who was actually in the room hears the owner leave.
          for (const deviceId of joined) {
            notify(deviceId, {
              kind: 'invite', event: 'left', room_id: msg.room_id, from_device_id: conn.deviceId,
            })
          }
          // Pending rows the OTHER side initiated are join requests — either
          // already relayed ('invited') or still parked awaiting the user's
          // consent ('awaiting_user', never delivered to any agent socket).
          // Either way that peer is blocked waiting for an answer this
          // dissolve just made impossible, and neither the expiry sweep nor
          // the awaiting-TTL sweep can rescue it (the row is 'left', not
          // 'invited'/'awaiting_user' anymore). Close the loop with the same
          // synthetic-refusal frame both sweeps send — no from_device_id, so
          // the initiator's existing expiry/timeout handling fires
          // unchanged — only the reason differs ('left' vs 'expired'). Rows
          // the owner itself initiated need nothing: for an 'invited' row
          // the owner is the side waiting on the peer's answer, and for an
          // 'awaiting_user' row the owner is the side waiting on the user's
          // decision — either way it is the one leaving, so no notification
          // is owed (and for the parked case the target never even knew).
          for (const row of pending) {
            if (row.initiator_device_id === conn.deviceId) continue
            notify(row.initiator_device_id, {
              kind: 'invite', event: 'answer', room_id: msg.room_id,
              peer_device_id: row.agent_device_id, accept: false, reason: 'left',
            })
          }
          break
        }
        if (!leaveConvo(db, { convoId: msg.room_id, agentDeviceId: conn.deviceId })) {
          return fail('conflict', 'not a joined participant')
        }
        // A participant left: tell the room's recorded owner, if there is
        // one. (No need to exclude the caller — a caller that IS the owner
        // has no convo_agents row to have been 'joined' in, so leaveConvo
        // above would have failed it into the conflict.)
        if (room.agent_device_id != null) {
          notify(room.agent_device_id, {
            kind: 'invite', event: 'left', room_id: msg.room_id, from_device_id: conn.deviceId,
          })
        }
        break
      }
      case 'read_marker': {
        // null means "resolve server-side to the conversation head" (see
        // markRead); anything else must be a genuine non-negative seq.
        if (msg.up_to_seq != null && (!Number.isInteger(msg.up_to_seq) || msg.up_to_seq < 0)) {
          return fail('bad_request')
        }
        // Privacy gate (spec: agent visibility & privacy, final-review
        // finding): read_marker has no membership check at all, so an
        // ORDINARY agent could otherwise both mark-read into a private
        // room it has no standing in (fanning a read_marker event out into
        // it) AND use the distinct forbidden-vs-success outcome as an
        // existence oracle for the private device's rooms. Same exemption
        // as loadRoom's gate: a private caller, or an ordinary caller that
        // is a known participant (isKnownParticipant — initiated, actually
        // delivered, or joined), passes unfiltered. Must run BEFORE
        // markRead so a refused mark never appends an event or fans out.
        // The unknown-id path below throws inside markRead and lands in
        // this same fail('forbidden') via the outer catch — reusing it
        // here keeps the two paths byte-identical, not just similarly
        // shaped.
        if (conn.kind === 'agent' && !isPrivateDevice(db, conn.deviceId)) {
          const room = db.prepare('SELECT owner_user_id, agent_device_id FROM conversations WHERE id=?').get(msg.convo_id)
          if (room && room.owner_user_id === conn.userId && room.agent_device_id != null
            && isPrivateDevice(db, room.agent_device_id) && !isKnownParticipant(db, msg.convo_id, conn.deviceId)) {
            return fail('forbidden')
          }
        }
        // Both kinds may advance the read marker: a client marking read for
        // itself, or an agent (bridge) marking read on behalf of its user —
        // e.g. after mirroring the user's own message into the journal, so
        // that mirrored round-trip doesn't inflate the unread badge. Sender
        // follows each connection's normal identity convention.
        const sender = conn.kind === 'agent' ? `agent:${conn.name}` : `user:${conn.username}`
        const r = markRead(db, conn.userId, msg.convo_id, msg.up_to_seq, sender)
        fanOut(journalFrame({
          seq: r.seq, convo_id: msg.convo_id, ts: r.ts,
          sender, type: 'read_marker',
          payload: { convo_id: msg.convo_id, up_to_seq: r.upToSeq },
        }))
        break
      }
      case 'convo_upsert': {
        if (conn.kind !== 'agent') return fail('forbidden')
        // parent_convo_id is optional; when present it must be a non-empty
        // string within the id length cap (a parent row need not exist yet —
        // ordering between a child's upsert and its parent's is not guaranteed,
        // so a dangling reference is stored as-is). Only agent connections
        // reach here, but validate defensively like every other agent input.
        if (msg.parent_convo_id != null && (
          typeof msg.parent_convo_id !== 'string'
          || msg.parent_convo_id.length === 0
          || msg.parent_convo_id.length > CONVO_ID_MAX_CHARS
        )) {
          return fail('bad_request', 'bad parent_convo_id')
        }
        // session_outcome is optional and, unlike session_state, is not
        // enumerated here — only shape-checked. An omitted outcome leaves any
        // previously recorded one untouched (COALESCE in upsertConversation).
        if (msg.session_outcome != null && (
          typeof msg.session_outcome !== 'string'
          || msg.session_outcome.length === 0
          || msg.session_outcome.length > SESSION_OUTCOME_MAX_CHARS
        )) {
          return fail('bad_request', 'bad session_outcome')
        }
        if (msg.summary != null && (typeof msg.summary !== 'string' || msg.summary.length > SUMMARY_MAX_CHARS)) {
          return fail('bad_request', 'bad summary')
        }
        // Room-upsert ownership gate (fix: convo_upsert takeover bypass). A
        // conversation with at least one convo_agents row (any state) is a
        // "room" — once participants have been drawn into its lifecycle,
        // ONLY the recorded owner may upsert it at all, joined guests and
        // uninvited strangers alike (a guest upsert would otherwise flap
        // session_state/title/summary the creator owns, or worse — with the
        // old code — become the recorded owner itself and cut the real
        // owner out of fan-out). A participant-less conversation keeps the
        // pre-existing last-writer-wins takeover (a re-paired bridge with a
        // new device id reclaiming its own sessions), and a conversation
        // with no recorded owner (legacy NULL rows) stays writable by
        // anyone. See docs/protocol.md "Agent delivery scoping". Scoped to
        // this user's own conversations: a foreign convo id must fall
        // through to upsertConversation's generic not-authorized rejection,
        // not this room-specific detail (which would tell another user's
        // agent that the id exists and is a populated room).
        const existingRoom = db.prepare('SELECT agent_device_id FROM conversations WHERE id=? AND owner_user_id=?').get(msg.convo_id, conn.userId)
        if (existingRoom && existingRoom.agent_device_id != null && existingRoom.agent_device_id !== conn.deviceId) {
          if (hasParticipants(db, msg.convo_id)) return fail('forbidden', 'only the room owner may upsert a room')
          // Private-owner takeover guard (spec: agent visibility & privacy,
          // final-review finding). A participant-less conversation normally
          // keeps the old last-writer-wins takeover (a re-paired bridge with
          // a new device id reclaiming its own sessions) — but when the
          // EXISTING owner is a private device, an ordinary caller must not
          // be able to silently reassign ownership of a conversation it has
          // no standing to touch. Reuses the exact same forbidden shape the
          // populated-room gate above already returns: that oracle class
          // (forbidden for something you can't touch, vs. a fresh id simply
          // creating) is an accepted trade-off there and is not a new one
          // here. A private caller is exempt (invisible, not blinded, same
          // rule as every other surface); the caller being the current
          // owner can't reach this branch at all (the outer condition above
          // already requires agent_device_id !== conn.deviceId).
          if (isPrivateDevice(db, existingRoom.agent_device_id) && !isPrivateDevice(db, conn.deviceId)) {
            return fail('forbidden', 'only the room owner may upsert a room')
          }
        }
        const convo = upsertConversation(db, {
          id: msg.convo_id, ownerUserId: conn.userId,
          title: msg.title, sessionState: msg.session_state,
          agentDeviceId: conn.deviceId,
          parentConvoId: msg.parent_convo_id ?? null,
          sessionOutcome: msg.session_outcome ?? null,
          summary: msg.summary ?? null,
        })
        if (msg.session_state) {
          // prevSessionState is upsertConversation's read of the row BEFORE
          // this update — an in-memory hint only, so push.js can tell a
          // turn-finished transition (running -> waiting/done) from a
          // teardown of an already-idle session (waiting -> done). Never
          // stored or broadcast.
          appendAndFan({
            userId: conn.userId, convoId: msg.convo_id,
            sender: `agent:${conn.name}`, type: 'session_status',
            // session_outcome rides the status event so a live client learns
            // the terminal outcome without waiting for its next /snapshot.
            // Read back from the stored row rather than the frame, so the
            // event agrees with the snapshot even on a state-only upsert of a
            // conversation that already resolved. The key is omitted entirely
            // when there is no outcome, leaving every existing conversation's
            // payload byte-identical to before.
            payload: convo.session_outcome
              ? { state: msg.session_state, session_outcome: convo.session_outcome }
              : { state: msg.session_state },
            pushHint: { prevSessionState: convo.prevSessionState },
          })
        }
        // Other devices learn renames live instead of only via /snapshot.
        // No event when the title is unchanged, absent, or this was a
        // state-only upsert (see upsertConversation's metaChanged logic).
        if (convo.metaChanged) {
          appendAndFan({
            userId: conn.userId, convoId: msg.convo_id,
            sender: `agent:${conn.name}`, type: 'convo_meta',
            // agent_device_id rides the meta event so a live client can show
            // which box owns a conversation the moment it appears, without
            // waiting for the next /snapshot. Always this connection's
            // device — upsertConversation records the same id.
            payload: {
              title: convo.title,
              parent_convo_id: convo.parent_convo_id ?? null,
              agent_device_id: conn.deviceId,
            },
          })
        }
        break
      }
      case 'publish': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (typeof msg.type !== 'string' || !AGENT_PUBLISH_TYPES.has(msg.type) || typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        // The agent_chat consent card is minted only by the server's own
        // agent_invite/agent_join park path, which sanitises from_name/
        // topic/justification before append. A bare publish never runs that
        // sanitiser, so letting one through here would let any agent forge
        // an unsanitised, impersonating consent card into a room it manages.
        if (isClientOnlyEvent(msg.type, msg.payload)) return fail('bad_request', 'agent_chat consent cards are server-minted only')
        // finalize composes `fin:<ref>` idem keys internally — a raw publish
        // must not be able to collide with (or forge) one of those.
        if (typeof msg.idem_key === 'string' && msg.idem_key.startsWith('fin:')) {
          return fail('bad_request', 'idem_key prefix fin: is reserved')
        }
        // Wrong-conversation tightening (spec: agent chat phase 2): an agent
        // device writes only into conversations it manages or has joined.
        // append() would reject a cross-USER convo anyway; this closes the
        // same-user cross-DEVICE hole with an explicit error frame.
        if (!authorizeAgentWrite(db, conn.userId, conn.deviceId, msg.convo_id)) {
          return fail('forbidden', 'not a participant of this conversation')
        }
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type: msg.type, payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: msg.idem_key ? `agent:${conn.deviceId}:${msg.idem_key}` : null,
        })
        break
      }
      case 'stream': {
        if (conn.kind !== 'agent') return fail('forbidden')
        // Ownership check, matching every other agent write path (activity/
        // status/stream_append all call authorizeAgentWrite()). Previously omitted here
        // on the theory that sendEphemeral's own user-scoping made it inert —
        // but that only bounds the blast radius to the agent's own user; within
        // that user, a bridge could still spoof a live text overlay into a
        // conversation it does not own. Fail closed instead, uniformly.
        if (!authorizeAgentWrite(db, conn.userId, conn.deviceId, msg.convo_id)) return fail('forbidden')
        // Overlay text is bounded by the 1 MiB WS frame cap and is never
        // retained (transient, latest-wins in the coalescer), so no separate
        // byte cap is needed — but reject a non-string text/replace_text rather
        // than forwarding a mistyped frame verbatim to viewers.
        if (msg.text != null && typeof msg.text !== 'string') return fail('bad_request')
        if (msg.replace_text != null && typeof msg.replace_text !== 'string') return fail('bad_request')
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, message_ref: msg.message_ref,
          text: msg.text, replace_text: msg.replace_text,
        })
        break
      }
      case 'stream_append': {
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!authorizeAgentWrite(db, conn.userId, conn.deviceId, msg.convo_id)) return fail('forbidden')
        if (typeof msg.message_ref !== 'string' || !msg.message_ref) return fail('bad_request')
        if (typeof msg.chunk !== 'string' || !Number.isInteger(msg.offset) || msg.offset < 0) return fail('bad_request')
        const r = toolStreams.append({
          userId: conn.userId, convoId: msg.convo_id, ref: msg.message_ref,
          offset: msg.offset, chunk: msg.chunk, meta: msg.meta,
          // Tag the buffer with this producer connection so a producer
          // disconnect (ws 'close' above) can cascade-close exactly the streams
          // it opened, emitting the terminal end{disconnected} frame.
          producer: conn,
        })
        if (r.status === 'need_meta') return fail('bad_request', 'meta required on buffer-creating frame')
        if (r.status === 'resync') {
          conn.ws.send(JSON.stringify({
            kind: 'control', op: 'stream_resync',
            convo_id: msg.convo_id, message_ref: msg.message_ref, have: r.have,
          }))
          break
        }
        if (r.status === 'duplicate') break
        for (const ev of r.evicted) notifyStale(hub, ev)
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, message_ref: msg.message_ref,
          tool_stream: { event: 'append', offset: r.offset, chunk: r.accepted },
        })
        break
      }
      case 'activity': {
        // Same ownership stance as every other agent write path (append/
        // markRead/upsertConversation): missing or not-owned fails closed as
        // forbidden. Unlike those, this never touches the journal — it's
        // purely a hub.sendEphemeral fan-out, same delivery path as stream
        // (viewing-scoped, coalesced, never throws on a dead/slow socket).
        if (conn.kind !== 'agent') return fail('forbidden')
        if (!ACTIVITY_STATES.has(msg.state)) return fail('bad_request')
        if (!authorizeAgentWrite(db, conn.userId, conn.deviceId, msg.convo_id)) return fail('forbidden')
        const detail = typeof msg.detail === 'string' ? msg.detail.slice(0, ACTIVITY_DETAIL_MAX_CHARS) : undefined
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id,
          activity: { state: msg.state, detail },
        })
        break
      }
      case 'status': {
        // Same ownership stance and delivery path as `activity`, with one
        // difference: the last status per convo is cached (bounded, memory
        // only) and replayed on `viewing`, so a client opening a convo gets
        // a populated header immediately instead of waiting for the next
        // turn end. The payload is opaque to the server — validated only as
        // a size-capped object, so the bridge can evolve the shape without
        // a server deploy.
        if (conn.kind !== 'agent') return fail('forbidden')
        if (typeof msg.status !== 'object' || msg.status === null) return fail('bad_request')
        if (!authorizeAgentWrite(db, conn.userId, conn.deviceId, msg.convo_id)) return fail('forbidden')
        let encoded
        try { encoded = JSON.stringify(msg.status) } catch { return fail('bad_request') }
        if (Buffer.byteLength(encoded, 'utf8') > STATUS_MAX_BYTES) return fail('bad_request', 'status too large')
        statusCache.set(conn.userId, msg.convo_id, msg.status)
        hub.sendEphemeral(conn.userId, msg.convo_id, {
          kind: 'ephemeral', convo_id: msg.convo_id, status: msg.status,
        })
        break
      }
      case 'host_vitals': {
        // Host-global machine vitals (cpu/ram/sampled_at_ms) sampled by the
        // bridge and relayed to EVERY one of the user's clients. Same
        // agent-only stance as status, but deliberately NOT convo-scoped: the
        // frame carries no convo_id, there is no authorize() ownership check
        // (host vitals belong to the machine, not a conversation), and the
        // broadcast bypasses the viewingConvoId filter that sendEphemeral
        // applies. Never journaled — pure ephemeral, so no appendAndFan. The
        // last sample is cached per user and replayed on client connect.
        // Payload is opaque to the server, validated only as a size-capped
        // non-null object so the bridge can evolve the shape without a deploy.
        if (conn.kind !== 'agent') return fail('forbidden')
        if (typeof msg.vitals !== 'object' || msg.vitals === null) return fail('bad_request')
        let encoded
        try { encoded = JSON.stringify(msg.vitals) } catch { return fail('bad_request') }
        if (Buffer.byteLength(encoded, 'utf8') > STATUS_MAX_BYTES) return fail('bad_request', 'vitals too large')
        // Min-interval throttle: drop (silently) frames arriving faster than
        // the floor from this connection. Checked AFTER validation so a
        // rejected frame never consumes the interval, and BEFORE the cache
        // write/broadcast so a flood can neither churn the cache nor fan out.
        const nowMs = Date.now()
        if (conn._lastVitalsMs != null && nowMs - conn._lastVitalsMs < VITALS_MIN_INTERVAL_MS) break
        conn._lastVitalsMs = nowMs
        vitalsCache.set(conn.userId, msg.vitals)
        hub.broadcastVitals(conn.userId, { kind: 'ephemeral', host_vitals: msg.vitals })
        break
      }
      case 'finalize': {
        if (conn.kind !== 'agent') return fail('forbidden')
        // finalize's type is raw agent input just like publish's — without
        // the same whitelist it would be a bypass route for forging
        // server-generated types (session_status/read_marker/convo_meta).
        const type = msg.type || 'text'
        if (!AGENT_PUBLISH_TYPES.has(type)) return fail('bad_request')
        if (typeof msg.payload !== 'object' || msg.payload === null) return fail('bad_request')
        // Same server-only-mint rule as publish — see the comment there.
        if (isClientOnlyEvent(type, msg.payload)) return fail('bad_request', 'agent_chat consent cards are server-minted only')
        // Wrong-conversation tightening (spec: agent chat phase 2): an agent
        // device writes only into conversations it manages or has joined.
        // append() would reject a cross-USER convo anyway; this closes the
        // same-user cross-DEVICE hole with an explicit error frame.
        if (!authorizeAgentWrite(db, conn.userId, conn.deviceId, msg.convo_id)) {
          return fail('forbidden', 'not a participant of this conversation')
        }
        appendAndFan({
          userId: conn.userId, convoId: msg.convo_id,
          sender: `agent:${conn.name}`, type, payload: msg.payload,
          blobRef: msg.blob_ref ?? null,
          idemKey: `agent:${conn.deviceId}:fin:${msg.message_ref}`,
        })
        // Normal end-of-stream for a live tool-output overlay: the durable
        // event above retires the client's view (same message_ref in its
        // payload), so the buffer can go — no 'end' ephemeral needed. A no-op
        // for every finalize that never streamed.
        toolStreams.free(msg.convo_id, msg.message_ref)
        break
      }
      default:
        break
    }
  } catch (e) {
    if (/not authorized/.test(e.message)) return fail('forbidden')
    throw e
  }
}

export { journalFrame }
