import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation, snapshot, eventsAfter, messagesBefore, markRead, snippetOf, isClientOnlyEvent } from '../src/journal.js'
import { inviteParticipant } from '../src/participants.js'

async function setup() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, title: 'fix tests' })
  return { db, dan }
}

test('append allocates contiguous per-user seq and updates summary', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id })
  const a = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'hello' } })
  const b = append(db, { userId: dan.id, convoId: 'c2', sender: 'agent:dev-2', type: 'text', payload: { body: 'world' } })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  const c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.last_seq, 1)
  assert.equal(c1.unread_count, 1)
  assert.equal(c1.snippet, 'hello')
})

test('session_status updates state without bumping unread', async () => {
  const { db, dan } = await setup()
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'session_status', payload: { state: 'waiting' } })
  const c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.session_state, 'waiting')
  assert.equal(c1.unread_count, 0)
})

test('idempotency key dedupes', async () => {
  const { db, dan } = await setup()
  const p = { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'x' }, idemKey: 'a1:m1' }
  const first = append(db, p)
  const again = append(db, p)
  assert.equal(again.seq, first.seq)
  assert.equal(again.duplicate, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 1)
  const c1 = db.prepare("SELECT last_seq, unread_count FROM conversations WHERE id='c1'").get()
  assert.equal(c1.last_seq, first.seq)
  assert.equal(c1.unread_count, 1)
})

test('same idemKey in different conversations inserts both', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'c2', ownerUserId: dan.id })
  const a = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'one' }, idemKey: 'fin:m1' })
  const b = append(db, { userId: dan.id, convoId: 'c2', sender: 'agent:a', type: 'text', payload: { body: 'two' }, idemKey: 'fin:m1' })
  assert.equal(b.duplicate, false)
  assert.notEqual(a.seq, b.seq)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM events').get().n, 2)
})

test('append to unowned convo throws', async () => {
  const { db } = await setup()
  const pat = await createUser(db, 'pat', 'pw')
  assert.throws(
    () => append(db, { userId: pat.id, convoId: 'c1', sender: 'user:pat', type: 'text', payload: {} }),
    /not authorized/
  )
})

test('snapshot, replay, pagination, read markers', async () => {
  const { db, dan } = await setup()
  for (let i = 1; i <= 5; i++) {
    append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: `m${i}` } })
  }
  const snap = snapshot(db, dan.id)
  assert.equal(snap.seq, 5)
  assert.equal(snap.conversations[0].unread_count, 5)
  // last_ts mirrors the newest event's ts so clients can render a correct
  // "last activity" time from a snapshot alone; NULL with no events.
  const newestTS = db.prepare("SELECT ts FROM events WHERE convo_id='c1' ORDER BY seq DESC LIMIT 1").get().ts
  assert.equal(snap.conversations[0].last_ts, newestTS)
  upsertConversation(db, { id: 'c-empty', ownerUserId: dan.id, title: 'no events yet' })
  const snap2 = snapshot(db, dan.id)
  assert.equal(snap2.conversations.find((c) => c.id === 'c-empty').last_ts, null)

  const replay = eventsAfter(db, dan.id, 2)
  assert.deepEqual(replay.map((e) => e.seq), [3, 4, 5])
  assert.equal(replay[0].payload.body, 'm3')

  const page = messagesBefore(db, dan.id, 'c1', { beforeSeq: 5, limit: 2 })
  assert.deepEqual(page.map((e) => e.seq), [3, 4])

  const rm = markRead(db, dan.id, 'c1', 4)
  assert.equal(rm.seq, 6) // read_marker is itself a journal event
  assert.equal(db.prepare("SELECT unread_count FROM conversations WHERE id='c1'").get().unread_count, 1)
  // sender must match the username format used by send/prompt_reply, not the numeric id
  assert.equal(db.prepare('SELECT sender FROM events WHERE seq=?').get(rm.seq).sender, 'user:dan')
})

test('messagesBefore rejects foreign convo', async () => {
  const { db } = await setup()
  const pat = await createUser(db, 'pat2', 'pw')
  assert.throws(() => messagesBefore(db, pat.id, 'c1', {}), /not authorized/)
})

test('a user-sender message does not bump unread; an agent-sender message does', async () => {
  const { db, dan } = await setup()
  const mine = append(db, { userId: dan.id, convoId: 'c1', sender: 'user:dan', type: 'text', payload: { body: 'mine' } })
  let c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 0)
  assert.equal(c1.last_seq, mine.seq)
  assert.equal(c1.snippet, 'mine') // snippet still tracks the latest message either way

  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'theirs' } })
  c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 1)
})

test('markRead with up_to_seq >= last_seq resets unread_count to 0', async () => {
  const { db, dan } = await setup()
  for (let i = 1; i <= 3; i++) {
    append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: `m${i}` } })
  }
  let c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 3)
  markRead(db, dan.id, 'c1', c1.last_seq)
  c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 0)
})

test('markRead with up_to_seq null resolves server-side to the conversation head', async () => {
  const { db, dan } = await setup()
  for (let i = 1; i <= 3; i++) {
    append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: `m${i}` } })
  }
  const before = db.prepare("SELECT last_seq FROM conversations WHERE id='c1'").get()
  const r = markRead(db, dan.id, 'c1', null)
  assert.equal(r.upToSeq, before.last_seq)
  const c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 0)
  const row = db.prepare('SELECT payload FROM events WHERE seq=?').get(r.seq)
  assert.equal(JSON.parse(row.payload).up_to_seq, before.last_seq)
})

test('markRead fails closed on a convo the caller does not own', async () => {
  const { db } = await setup()
  const pat = await createUser(db, 'pat3', 'pw')
  assert.throws(() => markRead(db, pat.id, 'c1', null), /not authorized/)
  assert.throws(() => markRead(db, pat.id, 'c1', 4), /not authorized/)
})

test('upsertConversation stores parent_convo_id at creation and defaults it to null', async () => {
  const { db, dan } = await setup()
  const child = upsertConversation(db, { id: 'child', ownerUserId: dan.id, parentConvoId: 'c1' })
  assert.equal(child.parent_convo_id, 'c1')
  // c1 was created (in setup) without a parent -> null, not undefined.
  const c1 = db.prepare("SELECT parent_convo_id FROM conversations WHERE id='c1'").get()
  assert.equal(c1.parent_convo_id, null)
})

test('parent_convo_id is immutable: a later upsert cannot clear or change it', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: dan.id, title: 'sub', parentConvoId: 'c1' })
  // later upsert WITHOUT the field must not clear it
  upsertConversation(db, { id: 'child', ownerUserId: dan.id, sessionState: 'waiting' })
  assert.equal(db.prepare("SELECT parent_convo_id FROM conversations WHERE id='child'").get().parent_convo_id, 'c1')
  // later upsert WITH a different value must not change it
  upsertConversation(db, { id: 'child', ownerUserId: dan.id, parentConvoId: 'c2' })
  assert.equal(db.prepare("SELECT parent_convo_id FROM conversations WHERE id='child'").get().parent_convo_id, 'c1')
  // a convo created WITHOUT a parent cannot gain one later either
  upsertConversation(db, { id: 'c1', ownerUserId: dan.id, parentConvoId: 'child' })
  assert.equal(db.prepare("SELECT parent_convo_id FROM conversations WHERE id='c1'").get().parent_convo_id, null)
})

test('snapshot rows carry parent_convo_id (null for normal convos, set for children)', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: dan.id, title: 'sub', parentConvoId: 'c1' })
  const snap = snapshot(db, dan.id)
  assert.equal(snap.conversations.find((c) => c.id === 'c1').parent_convo_id, null)
  assert.equal(snap.conversations.find((c) => c.id === 'child').parent_convo_id, 'c1')
})

test('creating a titleless child still reports metaChanged so the linkage rides the journal', async () => {
  const { db, dan } = await setup()
  const child = upsertConversation(db, { id: 'child', ownerUserId: dan.id, parentConvoId: 'c1' })
  assert.equal(child.metaChanged, true, 'titleless child creation must fan out convo_meta')
  // Control: a titleless creation WITHOUT a parent stays silent, as before.
  const plain = upsertConversation(db, { id: 'plain', ownerUserId: dan.id })
  assert.equal(plain.metaChanged, false)
})

test('a partial markRead on a child convo cannot resurrect unread_count', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: dan.id, parentConvoId: 'c1' })
  const first = append(db, { userId: dan.id, convoId: 'child', sender: 'agent:dev-2', type: 'text', payload: { body: 'one' } })
  append(db, { userId: dan.id, convoId: 'child', sender: 'agent:dev-2', type: 'text', payload: { body: 'two' } })
  // Reading only up to the first event leaves one agent message beyond
  // up_to_seq — the recompute must not count it for a silent child.
  markRead(db, dan.id, 'child', first.seq)
  assert.equal(db.prepare("SELECT unread_count FROM conversations WHERE id='child'").get().unread_count, 0)
})

test('a child convo (parent_convo_id set) never increments unread_count; the same event in a normal convo does', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: dan.id, parentConvoId: 'c1' })
  append(db, { userId: dan.id, convoId: 'child', sender: 'agent:dev-2', type: 'text', payload: { body: 'sub work' } })
  const child = db.prepare("SELECT unread_count, last_seq, snippet FROM conversations WHERE id='child'").get()
  assert.equal(child.unread_count, 0, 'silent child must not bump unread')
  // last_seq/snippet still track the event — only unread is exempt.
  assert.ok(child.last_seq > 0)
  assert.equal(child.snippet, 'sub work')
  // Control: the identical agent event in a normal convo DOES bump unread.
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'sub work' } })
  assert.equal(db.prepare("SELECT unread_count FROM conversations WHERE id='c1'").get().unread_count, 1)
})

test('snippetOf shows a captioned attachment as what the user said, not [image]', () => {
  assert.equal(
    snippetOf('image', { blob_ref: 'b1', name: 'shot.png', caption: 'why is this rotated?' }),
    'why is this rotated?')
  assert.equal(
    snippetOf('file', { blob_ref: 'b2', name: 'contract.pdf', caption: 'review before Friday' }),
    'review before Friday')
  // No caption: the placeholder is still the best available description.
  assert.equal(snippetOf('image', { blob_ref: 'b1', name: 'shot.png' }), '[image]')
  assert.equal(snippetOf('file', { blob_ref: 'b2' }), '[file]')
  // Long captions are truncated like every other snippet.
  assert.equal(snippetOf('image', { caption: 'x'.repeat(200) }).length, 120)
})

// T-2.2: a peer_message snippet renders the sanitized BODY (💬-prefixed), never
// the literal [peer_message] placeholder — the operator sees the coordination
// line in the convo list.
test('snippetOf renders a peer_message as its sanitized body, never [peer_message]', () => {
  assert.equal(snippetOf('peer_message', { body: 'ship the invoice fix' }), '💬 ship the invoice fix')
  assert.notEqual(snippetOf('peer_message', { body: 'x' }), '[peer_message]')
  // newline/control flattened by sanitizePeerText before prefixing
  assert.equal(snippetOf('peer_message', { body: 'a\nb' }), '💬 a b')
  // capped like every other snippet
  assert.ok(snippetOf('peer_message', { body: 'y'.repeat(300) }).length <= 120)
})

test('snippetOf tolerates null/undefined/non-object payloads for every type, without throwing', () => {
  for (const type of ['text', 'prompt', 'permission_request', 'tool_output', 'diff', 'unknown_type']) {
    assert.doesNotThrow(() => snippetOf(type, null), `type=${type} payload=null`)
    assert.doesNotThrow(() => snippetOf(type, undefined), `type=${type} payload=undefined`)
    assert.doesNotThrow(() => snippetOf(type, 'not an object'), `type=${type} payload=string`)
    assert.doesNotThrow(() => snippetOf(type, 42), `type=${type} payload=number`)
  }
  assert.equal(snippetOf('text', null), '')
  assert.equal(snippetOf('prompt', undefined), '? ')
  assert.equal(snippetOf('permission_request', null), 'permission: ')
  assert.equal(snippetOf('unknown_type', null), '[unknown_type]')
})

test('snippetOf session_status reads as the turn-finished alert, matching the relay fixed string', () => {
  // The only session_status events that ever reach a push body are
  // turn-finished ones (see push.js classify()), so the state itself
  // doesn't vary the wording.
  assert.equal(snippetOf('session_status', { state: 'waiting' }), 'Turn finished')
  assert.equal(snippetOf('session_status', { state: 'done' }), 'Turn finished')
  assert.equal(snippetOf('session_status', null), 'Turn finished')
})

test('snippetOf spawn_outcome shows an outcome-specific placeholder, falling back to [spawn_outcome] for an unknown/missing outcome', () => {
  assert.equal(snippetOf('spawn_outcome', { outcome: 'started' }), '🚀 Spawned session started')
  assert.equal(snippetOf('spawn_outcome', { outcome: 'declined' }), '🚫 Spawn declined')
  assert.equal(snippetOf('spawn_outcome', { outcome: 'expired' }), '⌛ Spawn request expired')
  assert.equal(snippetOf('spawn_outcome', { outcome: 'failed' }), '❌ Spawn failed')
  assert.equal(snippetOf('spawn_outcome', {}), '[spawn_outcome]')
})

test('append with type session_status and a malformed payload throws a clean, descriptive error (not a raw DB crash)', async () => {
  const { db, dan } = await setup()
  for (const badPayload of [null, undefined, {}, 'nope', 42, { state: 42 }]) {
    assert.throws(
      () => append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'session_status', payload: badPayload }),
      /invalid session_status payload/,
      `payload=${JSON.stringify(badPayload)}`
    )
  }
  // nothing landed, and the conversation's session_state is untouched
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='session_status'").get().n, 0)
  assert.equal(db.prepare("SELECT session_state FROM conversations WHERE id='c1'").get().session_state, 'running')

  // a well-formed payload still works
  const r = append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'session_status', payload: { state: 'waiting' } })
  assert.ok(r.seq > 0)
  assert.equal(db.prepare("SELECT session_state FROM conversations WHERE id='c1'").get().session_state, 'waiting')
})

test('append with a MESSAGE_TYPES type and a null/non-object payload does not crash', async () => {
  const { db, dan } = await setup()
  assert.doesNotThrow(() => append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: null }))
  const c1 = db.prepare("SELECT snippet, last_seq, unread_count FROM conversations WHERE id='c1'").get()
  assert.equal(c1.snippet, '')
  assert.equal(c1.unread_count, 1)
})

test('snippetOf tool_output falls back to `$ command` when snippet is absent', () => {
  assert.equal(snippetOf('tool_output', { command: 'make test', expired: true }), '$ make test')
  // snippet still wins when present
  assert.equal(snippetOf('tool_output', { command: 'make', snippet: 'tail line' }), 'tail line')
  // no command, no snippet -> generic placeholder (unchanged)
  assert.equal(snippetOf('tool_output', { expired: true }), '[tool_output]')
  // 120-char cap
  const long = 'x'.repeat(300)
  const s = snippetOf('tool_output', { command: long })
  assert.equal(s.length, 120)
  assert.ok(s.startsWith('$ x'))
})

test('a participant upsert never steals agent_device_id; a non-participant still takes over', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const owner = createAgent(db, dan.id, 'dev-a')
  const guest = createAgent(db, dan.id, 'dev-b')
  const fresh = createAgent(db, dan.id, 'dev-c')
  upsertConversation(db, { id: 'room', ownerUserId: dan.id, title: 'room', sessionState: 'running', agentDeviceId: owner.deviceId })
  // Guest is a participant in ANY state (invited is enough — being invited
  // makes you categorically a guest).
  inviteParticipant(db, { convoId: 'room', agentDeviceId: guest.deviceId, initiatorDeviceId: owner.deviceId, justification: 'x' })
  upsertConversation(db, { id: 'room', ownerUserId: dan.id, sessionState: 'running', agentDeviceId: guest.deviceId })
  assert.equal(db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('room').agent_device_id, owner.deviceId)
  // A device with no participant row keeps the last-writer-wins takeover
  // (bridge re-pair reclaiming its own sessions under a new device id).
  upsertConversation(db, { id: 'room', ownerUserId: dan.id, sessionState: 'running', agentDeviceId: fresh.deviceId })
  assert.equal(db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('room').agent_device_id, fresh.deviceId)
})

test('summary: set via upsert, kept when omitted, returned by snapshot', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const ag = createAgent(db, dan.id, 'dev-a')
  upsertConversation(db, { id: 's1', ownerUserId: dan.id, title: 't', sessionState: 'running', agentDeviceId: ag.deviceId, summary: 'debugging CI' })
  assert.equal(db.prepare('SELECT summary FROM conversations WHERE id=?').get('s1').summary, 'debugging CI')
  // Don't-clobber: an upsert without summary keeps the stored one (July
  // title-revert discipline).
  upsertConversation(db, { id: 's1', ownerUserId: dan.id, sessionState: 'running', agentDeviceId: ag.deviceId })
  assert.equal(db.prepare('SELECT summary FROM conversations WHERE id=?').get('s1').summary, 'debugging CI')
  upsertConversation(db, { id: 's1', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: 'fixed CI, now on tests' })
  const snap = snapshot(db, dan.id)
  assert.equal(snap.conversations.find((c) => c.id === 's1').summary, 'fixed CI, now on tests')
})

// The load-bearing guarantee of the pinned-summary surface (spec: loop #554).
// The stamp feeds an "updated Nm ago" label; if a re-sent identical summary
// moved it, a bridge backfilling its saved digests on reconnect would stamp
// every old digest as fresh — the surface would confidently report the exact
// staleness the field exists to disclose. Date.now is pinned per call so the
// assertions test the guard, not the clock's millisecond resolution.
test('summary_updated_at: advances only on a real content change', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const ag = createAgent(db, dan.id, 'dev-a')
  const realNow = Date.now
  const at = (ms, fn) => { Date.now = () => ms; try { return fn() } finally { Date.now = realNow } }
  const stamp = () => db.prepare('SELECT summary_updated_at FROM conversations WHERE id=?').get('s1').summary_updated_at

  // Creation with no summary: never-set sentinel, not "now".
  at(1000, () => upsertConversation(db, { id: 's1', ownerUserId: dan.id, title: 't', sessionState: 'running', agentDeviceId: ag.deviceId }))
  assert.equal(stamp(), 0, 'a summary-less creation must read "never"')

  // First real summary stamps.
  const first = at(2000, () => upsertConversation(db, { id: 's1', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: '• a' }))
  assert.equal(stamp(), 2000)
  assert.equal(first.metaChanged, true, 'a summary change must fan a convo_meta')

  // Byte-identical re-send: no move, no event. This is the requirement.
  const resend = at(3000, () => upsertConversation(db, { id: 's1', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: '• a' }))
  assert.equal(stamp(), 2000, 're-sending the same summary must not move the stamp')
  assert.equal(resend.metaChanged, false, 're-sending the same summary must not fan an event')

  // Summary-omitting upsert (a title change, a state-only housekeeping
  // upsert): don't-clobber applies to the stamp as well as the text.
  const titleOnly = at(4000, () => upsertConversation(db, { id: 's1', ownerUserId: dan.id, title: 't2', agentDeviceId: ag.deviceId }))
  assert.equal(stamp(), 2000, 'an upsert that omits the summary must not move the stamp')
  assert.equal(db.prepare('SELECT summary FROM conversations WHERE id=?').get('s1').summary, '• a')
  assert.equal(titleOnly.metaChanged, true, 'the title still changed')

  // A genuine change moves it.
  at(5000, () => upsertConversation(db, { id: 's1', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: '• a\n• b' }))
  assert.equal(stamp(), 5000)

  // Clearing is a change too — otherwise a cleared surface would keep an
  // age label describing text that is gone.
  const cleared = at(6000, () => upsertConversation(db, { id: 's1', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: '' }))
  assert.equal(db.prepare('SELECT summary FROM conversations WHERE id=?').get('s1').summary, '')
  assert.equal(stamp(), 6000)
  assert.equal(cleared.metaChanged, true)

  // ...and clearing an already-empty summary is not.
  at(7000, () => upsertConversation(db, { id: 's1', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: '' }))
  assert.equal(stamp(), 6000)

  assert.equal(Date.now, realNow, 'clock must be restored')
})

test('summary_updated_at: stamped at creation when the insert carries a summary, and exposed by snapshot', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const ag = createAgent(db, dan.id, 'dev-a')
  const before = Date.now()
  upsertConversation(db, { id: 'born', ownerUserId: dan.id, title: 't', agentDeviceId: ag.deviceId, summary: '• born with one' })
  upsertConversation(db, { id: 'bare', ownerUserId: dan.id, title: 't', agentDeviceId: ag.deviceId })
  const rows = snapshot(db, dan.id).conversations
  const born = rows.find((c) => c.id === 'born')
  const bare = rows.find((c) => c.id === 'bare')
  assert.ok(born.summary_updated_at >= before, 'a summary-carrying insert stamps now')
  assert.equal(born.summary, '• born with one')
  // A conversation that never had a summary reads ''/0 — the same values
  // every row predating the column reads, so the web surface renders nothing.
  assert.equal(bare.summary, '')
  assert.equal(bare.summary_updated_at, 0)
})

// Regression (Codex adversarial F2): a conversation minted by a summary-only
// upsert — no title, no parent, no state — used to append no event at all, so
// live clients could not learn the conversation OR its digest existed until
// their next /snapshot. "The bridge always sends a title first" is a property
// of today's producer, not of this contract.
test('summary_updated_at: a titleless summary-only creation still counts as meta-changed', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const ag = createAgent(db, dan.id, 'dev-a')

  const born = upsertConversation(db, { id: 'quiet', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: '• minted by a digest' })
  assert.equal(born.metaChanged, true, 'a summary-only creation must fan a convo_meta')
  assert.equal(born.title, '')
  assert.ok(born.summary_updated_at > 0)

  // An EMPTY summary is not news, so a bare creation stays silent exactly as
  // it did before — the only way to create without an event.
  const silent = upsertConversation(db, { id: 'silent', ownerUserId: dan.id, agentDeviceId: ag.deviceId, summary: '' })
  assert.equal(silent.metaChanged, false)
  const alsoSilent = upsertConversation(db, { id: 'silent2', ownerUserId: dan.id, agentDeviceId: ag.deviceId })
  assert.equal(alsoSilent.metaChanged, false)
})

test('agent_chat permission_request is client-only; everything else is not', () => {
  assert.equal(isClientOnlyEvent('permission_request', { kind: 'agent_chat' }), true)
  assert.equal(isClientOnlyEvent('permission_request', { kind: 'tool_use' }), false)
  assert.equal(isClientOnlyEvent('permission_request', null), false)
  assert.equal(isClientOnlyEvent('text', { kind: 'agent_chat' }), false)
})

test('agent_chat card snippet is fixed — never the justification', () => {
  const s = snippetOf('permission_request', { kind: 'agent_chat', justification: 'SECRET-DO-NOT-LEAK' })
  assert.equal(s, '🤝 Agent chat request')
  assert.ok(!s.includes('SECRET'))
})

test('last_ts counts message events only — status/meta/read_marker rows do not resurface a chat', async () => {
  const { db, dan } = await setup()
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'text', payload: { body: 'real message' } })
  const messageTS = db.prepare("SELECT ts FROM events WHERE convo_id='c1' ORDER BY seq DESC LIMIT 1").get().ts
  // Non-message rows land in `events` with fresh timestamps: the reaper's
  // session_status, membership/rename convo_meta fans, and read_marker
  // echoes. Stamp them well after the message to prove they are ignored —
  // append() stamps Date.now(), so push each row's ts forward directly.
  append(db, { userId: dan.id, convoId: 'c1', sender: 'agent:dev-2', type: 'session_status', payload: { state: 'done' } })
  append(db, { userId: dan.id, convoId: 'c1', sender: 'journal', type: 'convo_meta', payload: { participants: [1, 2] } })
  markRead(db, dan.id, 'c1', 1)
  db.prepare("UPDATE events SET ts = ts + 3600000 WHERE convo_id='c1' AND type != 'text'").run()
  const snap = snapshot(db, dan.id)
  assert.equal(snap.conversations.find((c) => c.id === 'c1').last_ts, messageTS)
})
