import { authorize } from './auth.js'
import { indexableBody } from './search.js'
import { sanitizePeerText, PEER_NAME_CAP } from './peer-text.js'
import { joinedAgentIds } from './participants.js'

export const MESSAGE_TYPES = [
  'text', 'tool_output', 'diff', 'prompt', 'permission_request', 'file', 'image',
]

// Cap for a convo id wherever one arrives from outside the process —
// ws.js's parent_convo_id/room_id validation and spawns.js's approveSpawn
// capping the bridge-returned `start` rpc's convo_id — same 128-char id
// ceiling as RPC request ids. Convo ids are conventionally Claude session
// UUIDs (36 chars); this is a defensive upper bound, not a format
// assertion. Lives here (not ws.js, where it originated) because spawns.js
// needs it too and importing it from ws.js would be circular (ws.js already
// imports from spawns.js).
export const CONVO_ID_MAX_CHARS = 128

// Events that must never reach an agent device, live or replayed. The
// agent-chat approval card carries a peer agent's justification — the whole
// consent design exists to keep that text away from agents until the user
// approves, and the target agent MANAGES the room conversation the card sits
// in, so the default fan-out would hand it straight over. The agent-spawn
// card is the same story from the other side: it carries the child's seed
// prompt as task text the user has not yet approved, published into the
// PARENT's own conversation — a parent agent must not read back its own
// unapproved ask, any more than a chat target may read an invite it hasn't
// accepted. One predicate, consumed by ws.js fanOut, ws.js hello replay, and
// http.js message reads — inlining the check at each site is how they drift
// apart.
export function isClientOnlyEvent(type, payload) {
  return type === 'permission_request' && !!payload && typeof payload === 'object'
    && (payload.kind === 'agent_chat' || payload.kind === 'agent_spawn')
}

export function snippetOf(type, payload) {
  // Tolerate whatever an agent hands us — null/undefined/a bare string or
  // number — rather than crashing on `payload.body` etc. A malformed
  // payload just yields an empty/placeholder snippet, never a thrown error.
  const p = payload && typeof payload === 'object' ? payload : {}
  if (isClientOnlyEvent(type, payload)) {
    return p.kind === 'agent_spawn' ? '🤝 Agent spawn request' : '🤝 Agent chat request'
  }
  if (type === 'text') return String(p.body || '').slice(0, 120)
  if (type === 'prompt') return `? ${String(p.question || '').slice(0, 110)}`
  if (type === 'permission_request') return `permission: ${String(p.description || '').slice(0, 100)}`
  // A captioned attachment reads better in the chat list as what the user
  // actually said than as a bare `[image]`. Ahead of the generic `p.snippet`
  // rule because a caption is the user's own words about this specific
  // attachment — the most specific description available.
  if ((type === 'image' || type === 'file') && p.caption) return String(p.caption).slice(0, 120)
  if (p.snippet) return String(p.snippet).slice(0, 120)
  if (type === 'tool_output' && p.command) return `$ ${String(p.command)}`.slice(0, 120)
  // Matches the relay's fixed 'done'-category alert (see relay.js
  // APS_ALERTS) — push.js's classify() only ever pushes a session_status
  // event for a turn-finished transition (running -> waiting or -> done).
  // "Turn", not "session": the session usually lives on after the turn
  // ends, and calling it finished read wrong (Dan, 2026-08-02).
  if (type === 'session_status') return 'Turn finished'
  return `[${type}]`
}

// Returns the conversation row plus `metaChanged` and `prevSessionState`.
// `metaChanged`: true when this call set metadata other devices must learn
// live — an existing convo's title actually changed, a brand-new convo was
// created with a non-empty title, or a child was created (parent_convo_id
// set: the linkage must ride the journal even titleless, or a live client
// would list the child as a normal conversation until its next /snapshot).
// Callers (ws.js) use the flag to decide whether to fan out a `convo_meta`
// journal event; no event on an unchanged title, an absent title, or a
// state-only upsert.
// `prevSessionState`: the session_state as it stood BEFORE this call
// (undefined for a brand-new convo). Purely an in-memory hint for the push
// pipeline's turn-finished detection (see push.js classify()) — never
// stored or broadcast, so it carries no wire/protocol weight.
export function upsertConversation(db, { id, ownerUserId, title, sessionState, agentDeviceId, parentConvoId, sessionOutcome, summary }) {
  const existing = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  const prevSessionState = existing ? existing.session_state : undefined
  let metaChanged = false
  if (existing) {
    if (existing.owner_user_id !== ownerUserId) throw new Error('not authorized: convo owned by another user')
    if (title != null && title !== existing.title) metaChanged = true
    // agent_device_id: last upsert wins — the device currently managing the
    // session owns delivery (see hub.js). An absent agentDeviceId leaves the
    // recorded owner untouched.
    // parent_convo_id is set once at creation and IMMUTABLE thereafter — it is
    // deliberately never written on the update path, so a later upsert that
    // omits it does not clear it and one carrying a different value does not
    // change it (child linkage is a fixed structural fact of the conversation).
    // session_outcome is the opposite: it is genuinely mutable (a run reaches
    // its terminal outcome long after the row exists) and follows the same
    // COALESCE-last-write-wins rule as session_state, so a bridge re-emitting
    // outcomes after a reconnect is idempotent and an upsert that omits it
    // leaves the recorded outcome alone.

    // Ownership no-steal (spec: agent chat phase 2, the "last-writer-wins
    // ownership flap" fix): a device that appears in convo_agents for this
    // conversation — any state — is categorically a guest; its upsert keeps
    // title/state fresh but never reassigns delivery ownership. A device
    // with NO participant row keeps the takeover behavior (a re-paired
    // bridge gets a new device id and must be able to reclaim its own
    // sessions).
    const guest = agentDeviceId != null
      && existing.agent_device_id != null
      && existing.agent_device_id !== agentDeviceId
      && !!db.prepare('SELECT 1 FROM convo_agents WHERE convo_id=? AND agent_device_id=?').get(id, agentDeviceId)

    db.prepare(
      'UPDATE conversations SET title=COALESCE(?, title), session_state=COALESCE(?, session_state), agent_device_id=COALESCE(?, agent_device_id), session_outcome=COALESCE(?, session_outcome), summary=COALESCE(?, summary) WHERE id=?'
    ).run(title ?? null, sessionState ?? null, guest ? null : (agentDeviceId ?? null), sessionOutcome ?? null, summary ?? null, id)
  } else {
    const initialTitle = title || ''
    db.prepare(
      'INSERT INTO conversations(id, owner_user_id, title, session_state, agent_device_id, parent_convo_id, session_outcome, summary, created_at) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(id, ownerUserId, initialTitle, sessionState || 'running', agentDeviceId ?? null, parentConvoId ?? null, sessionOutcome ?? null, summary || '', Date.now())
    if (initialTitle || parentConvoId) metaChanged = true
  }
  const convo = db.prepare('SELECT * FROM conversations WHERE id=?').get(id)
  return { ...convo, metaChanged, prevSessionState }
}

const nextSeq = (db, userId) =>
  db.prepare(
    'INSERT INTO user_seq(user_id, seq) VALUES(?,1) ON CONFLICT(user_id) DO UPDATE SET seq=seq+1 RETURNING seq'
  ).get(userId).seq

export function append(db, { userId, convoId, sender, type, payload, blobRef = null, idemKey = null }) {
  return db.transaction(() => {
    const convo = db.prepare('SELECT owner_user_id, parent_convo_id FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== userId) throw new Error('not authorized: convo missing or not owned')
    if (idemKey) {
      const dup = db.prepare('SELECT seq, ts FROM events WHERE user_id=? AND convo_id=? AND idem_key=?').get(userId, convoId, idemKey)
      if (dup) return { seq: dup.seq, ts: dup.ts, duplicate: true }
    }
    const seq = nextSeq(db, userId)
    const ts = Date.now()
    // JSON.stringify(undefined) is the JS value `undefined`, not a string —
    // binding that would hit the payload column's NOT NULL constraint as a
    // raw SQLite error. A caller that omits `payload` entirely gets `null`
    // stored instead, so this always fails at the same clean layer as an
    // explicit null/non-object payload (see the guards below).
    const payloadJson = JSON.stringify(payload === undefined ? null : payload)
    db.prepare(
      'INSERT INTO events(user_id, seq, convo_id, ts, sender, type, payload, blob_ref, idem_key) VALUES(?,?,?,?,?,?,?,?,?)'
    ).run(userId, seq, convoId, ts, sender, type, payloadJson, blobRef, idemKey)
    // Search index feed (spec: agent journal search) — same transaction as
    // the event row, so the index can never hold a row the journal doesn't
    // (or vice versa). Plain INSERT, never OR REPLACE/OR IGNORE: a duplicate
    // (user_id, seq) is impossible for a freshly-minted seq, and failing
    // loudly beats silently corrupting the external-content FTS pair.
    const searchBody = indexableBody(type, payload)
    if (searchBody != null) {
      db.prepare(
        'INSERT INTO search_messages(user_id, convo_id, seq, ts, sender, body) VALUES(?,?,?,?,?,?)'
      ).run(userId, convoId, seq, ts, sender, searchBody)
    }
    if (type === 'session_status') {
      // Guard against a malformed agent payload (null/undefined/non-object,
      // or an object with no string `state`) reaching the DB as a raw
      // bind-type or CHECK-constraint crash — fail with one clear, expected
      // error instead (still rolls back the whole transaction).
      const state = payload && typeof payload === 'object' ? payload.state : undefined
      if (typeof state !== 'string') throw new Error('invalid session_status payload: state must be a string')
      db.prepare('UPDATE conversations SET last_seq=?, session_state=? WHERE id=?')
        .run(seq, state, convoId)
    } else if (MESSAGE_TYPES.includes(type)) {
      // A user's own message (sender `user:*`) never inflates their own unread
      // badge — only content from someone/something else (an agent, mirroring
      // a bridge's remote participant) counts as unread. Keep this predicate in
      // sync with the recompute query in markRead() below.
      // Child conversations (parent_convo_id set) are silent: a subagent's
      // sub-chat rides the journal for durability but must never bump the
      // owner's unread badge (server-side "silent children", mirrored by the
      // push pipeline's short-circuit in push.js). last_seq/snippet still
      // advance — only the unread increment is exempt.
      const sql = sender.startsWith('user:') || convo.parent_convo_id != null
        ? 'UPDATE conversations SET last_seq=?, snippet=? WHERE id=?'
        : 'UPDATE conversations SET last_seq=?, unread_count=unread_count+1, snippet=? WHERE id=?'
      db.prepare(sql).run(seq, snippetOf(type, payload), convoId)
    } else {
      db.prepare('UPDATE conversations SET last_seq=? WHERE id=?').run(seq, convoId)
    }
    return { seq, ts, duplicate: false }
  })()
}

// Append + fan for JOURNAL-authored events (spawn-room lines, room meta) —
// the ws.js fanOut lives inside a connection closure this caller doesn't
// have. Same agent-targeting rules as fanOut: client-only events reach no
// agent; otherwise the recorded owner + joined participants. Differences,
// both deliberate: no sender_device_id (there is no producing connection)
// and no push pipeline (a journal-authored room line is not an
// attention-worthy push).
export function appendAndBroadcast(db, hub, { userId, convoId, sender, type, payload }) {
  const r = append(db, { userId, convoId, sender, type, payload })
  if (r.duplicate) return r
  const frame = { kind: 'journal', ...toEventShape({ seq: r.seq, convo_id: convoId, ts: r.ts, sender, type, payload }) }
  const ownerId = db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(convoId)?.agent_device_id ?? null
  const targets = isClientOnlyEvent(type, payload)
    ? new Set()
    : (ownerId == null ? null : new Set([ownerId, ...joinedAgentIds(db, convoId)]))
  hub.broadcastJournal(userId, frame, targets)
  return r
}

const parseRow = (r) => ({ ...r, payload: JSON.parse(r.payload) })

// Single source of truth for the public event shape shared by WS journal frames
// and HTTP pagination — strips internal columns (user_id, idem_key, blob_ref).
export const toEventShape = ({ seq, convo_id, ts, sender, type, payload }) =>
  ({ seq, convo_id, ts, sender, type, payload })

// `opts` (spec: agent visibility & privacy, task 8) — both default off, so
// the one existing call site (http.js /snapshot) is the only caller that
// opts in and every other hypothetical caller keeps the original shape:
//   - omitSnippet: never hand back the `snippet` column. snippetOf() can
//     surface tool_output text (where credentials land — see its `p.snippet`
//     branch), so this must apply to EVERY agent caller, not just filtered
//     ones. Mirrors /roster's deliberate snippet omission (same reason).
//   - excludePrivateOwned: same predicate shape as the roster's conversations
//     query — a private device's conversations are dropped unless
//     agent_device_id is NULL (never private-owned). Only for the "ordinary
//     agent" caller; clients and private agents pass this false.
export function snapshot(db, userId, { omitSnippet = false, excludePrivateOwned = false } = {}) {
  // last_ts: timestamp of the conversation's newest event, so a client can
  // show a correct "last activity" time from a snapshot alone. Without it,
  // a client refreshing via /snapshot after missing frames advanced the
  // snippet but kept a stale timestamp. NULL when a conversation has no
  // events (just created, or history pruned by retention) — clients fall
  // back to created_at. The (convo_id, seq) index makes the subquery a seek.
  const conversations = db.prepare(
    `SELECT id, title, session_state, session_outcome, last_seq, unread_count,
            ${omitSnippet ? 'NULL' : 'snippet'} AS snippet,
            parent_convo_id, summary, created_at, agent_device_id,
            (SELECT ts FROM events e WHERE e.convo_id = conversations.id
             ORDER BY e.seq DESC LIMIT 1) AS last_ts
     FROM conversations WHERE owner_user_id=?${excludePrivateOwned
       ? ` AND (agent_device_id IS NULL OR NOT EXISTS(
              SELECT 1 FROM devices d WHERE d.id=conversations.agent_device_id AND d.private=1))`
       : ''}
     ORDER BY last_seq DESC`
  ).all(userId)
  // id -> name for the user's agent boxes, so a client can render the
  // owning box of each conversation without a second round-trip. Same
  // privacy predicate as the conversation filter above: a filtered
  // (ordinary agent) caller must not learn private boxes exist. Client
  // devices are deliberately absent — they are not boxes.
  // Names go out through the same sieve /devices uses: pairing predates the
  // rename endpoint's validation, so a stored name can still carry newlines
  // or control characters.
  const agents = db.prepare(
    `SELECT id AS device_id, name FROM devices
     WHERE user_id=? AND kind='agent'${excludePrivateOwned ? ' AND private=0' : ''} ORDER BY id`
  ).all(userId).map((a) => ({
    device_id: a.device_id,
    name: a.name == null ? null : sanitizePeerText(a.name, PEER_NAME_CAP),
  }))
  const head = db.prepare('SELECT seq FROM user_seq WHERE user_id=?').get(userId)
  return { conversations, agents, seq: head ? head.seq : 0 }
}

export function eventsAfter(db, userId, cursor, limit = 500) {
  return db.prepare(
    'SELECT * FROM events WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?'
  ).all(userId, cursor, limit).map(parseRow)
}

export function messagesBefore(db, userId, convoId, { beforeSeq = null, limit = 50 } = {}) {
  if (!authorize(db, userId, convoId)) throw new Error('not authorized')
  const rows = beforeSeq == null
    ? db.prepare('SELECT * FROM events WHERE convo_id=? ORDER BY seq DESC LIMIT ?').all(convoId, limit)
    : db.prepare('SELECT * FROM events WHERE convo_id=? AND seq<? ORDER BY seq DESC LIMIT ?').all(convoId, beforeSeq, limit)
  return rows.reverse().map(parseRow)
}

// Context window for a search hit (spec: agent journal search, around_seq).
// floor(limit/2) rows strictly before the anchor, the remainder from the
// anchor up — so the anchor row itself is included when it exists, and
// either end of the conversation just yields a short window, never an
// error. Ascending order, same authorize() gate as messagesBefore.
export function messagesAround(db, userId, convoId, { aroundSeq, limit = 30 } = {}) {
  if (!authorize(db, userId, convoId)) throw new Error('not authorized')
  const before = Math.floor(limit / 2)
  const after = limit - before
  const rows = [
    ...db.prepare('SELECT * FROM events WHERE convo_id=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(convoId, aroundSeq, before).reverse(),
    ...db.prepare('SELECT * FROM events WHERE convo_id=? AND seq>=? ORDER BY seq LIMIT ?')
      .all(convoId, aroundSeq, after),
  ]
  return rows.map(parseRow)
}

// Same window shape as messagesAround, but the seq set is picked FROM
// search_messages — exactly the indexable (prose) set, indexed by
// (convo_id, seq) — instead of windowing over every event and filtering
// after. In a tool_output-heavy conversation, windowing over ALL events
// first can starve a small limit down to a couple of prose rows before the
// caller ever gets to filter; picking the window from the already-indexed
// set means every row returned is one the caller can see. The seqs found
// are then re-fetched from `events` (search_messages doesn't carry the full
// payload) and mapped through the same parseRow as every other reader.
export function messagesAroundIndexed(db, userId, convoId, { aroundSeq, limit = 30 } = {}) {
  if (!authorize(db, userId, convoId)) throw new Error('not authorized')
  const before = Math.floor(limit / 2)
  const after = limit - before
  const seqs = [
    ...db.prepare('SELECT seq FROM search_messages WHERE convo_id=? AND seq<? ORDER BY seq DESC LIMIT ?')
      .all(convoId, aroundSeq, before).map((r) => r.seq).reverse(),
    ...db.prepare('SELECT seq FROM search_messages WHERE convo_id=? AND seq>=? ORDER BY seq LIMIT ?')
      .all(convoId, aroundSeq, after).map((r) => r.seq),
  ]
  if (seqs.length === 0) return []
  const placeholders = seqs.map(() => '?').join(',')
  const rows = db.prepare(
    `SELECT * FROM events WHERE convo_id=? AND seq IN (${placeholders}) ORDER BY seq`
  ).all(convoId, ...seqs)
  return rows.map(parseRow)
}

// `sender` defaults to the caller's own `user:<name>` identity (the original
// client-only behavior) but callers may pass an explicit identity string —
// ws.js does, so an agent connection marking read on behalf of its user gets
// `agent:<name>` instead (see the read_marker op handler).
//
// `upToSeq: null` means "resolve to this conversation's current last_seq at
// processing time" — a bridge mirroring a user's own messages publishes
// fire-and-forget and never learns the seq it was assigned, so it can't pass
// an explicit cursor. Resolution happens inside this transaction so it's
// consistent with the recompute below.
export function markRead(db, userId, convoId, upToSeq, sender = null) {
  return db.transaction(() => {
    const convo = db.prepare('SELECT owner_user_id, last_seq FROM conversations WHERE id=?').get(convoId)
    if (!convo || convo.owner_user_id !== userId) throw new Error('not authorized: convo missing or not owned')
    const resolvedUpToSeq = upToSeq == null ? convo.last_seq : upToSeq
    const finalSender = sender ?? `user:${db.prepare('SELECT name FROM users WHERE id=?').get(userId).name}`
    const r = append(db, {
      userId, convoId, sender: finalSender, type: 'read_marker',
      payload: { convo_id: convoId, up_to_seq: resolvedUpToSeq },
    })
    const placeholders = MESSAGE_TYPES.map(() => '?').join(',')
    // Mirrors append()'s unread predicate: only non-`user:*`-sender messages
    // count as unread, so a recompute after read never resurrects the
    // reader's own messages as unread — and silent children
    // (parent_convo_id set) are skipped entirely, so a partial read_marker
    // can never resurrect a positive count append() would not have made.
    db.prepare(
      `UPDATE conversations SET unread_count=(
         SELECT COUNT(*) FROM events e WHERE e.convo_id=? AND e.seq>? AND e.type IN (${placeholders})
           AND e.sender NOT LIKE 'user:%'
       ) WHERE id=? AND parent_convo_id IS NULL`
    ).run(convoId, resolvedUpToSeq, ...MESSAGE_TYPES, convoId)
    return { ...r, upToSeq: resolvedUpToSeq }
  })()
}
