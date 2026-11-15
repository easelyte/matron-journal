import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation, snapshot, eventsAfter, messagesBefore, markRead, snippetOf, isClientOnlyEvent } from '../src/journal.js'
import { inviteParticipant } from '../src/participants.js'

async function setup() {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, title: 'fix tests' })
  return { db, alice }
}

test('append allocates contiguous per-user seq and updates summary', async () => {
  const { db, alice } = await setup()
  upsertConversation(db, { id: 'c2', ownerUserId: alice.id })
  const a = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: 'hello' } })
  const b = append(db, { userId: alice.id, convoId: 'c2', sender: 'agent:box-2', type: 'text', payload: { body: 'world' } })
  assert.equal(a.seq, 1)
  assert.equal(b.seq, 2)
  const c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.last_seq, 1)
  assert.equal(c1.unread_count, 1)
  assert.equal(c1.snippet, 'hello')
})

test('session_status updates state without bumping unread', async () => {
  const { db, alice } = await setup()
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'session_status', payload: { state: 'waiting' } })
  const c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.session_state, 'waiting')
  assert.equal(c1.unread_count, 0)
})

test('idempotency key dedupes', async () => {
  const { db, alice } = await setup()
  const p = { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: 'x' }, idemKey: 'a1:m1' }
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
  const { db, alice } = await setup()
  upsertConversation(db, { id: 'c2', ownerUserId: alice.id })
  const a = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'one' }, idemKey: 'fin:m1' })
  const b = append(db, { userId: alice.id, convoId: 'c2', sender: 'agent:a', type: 'text', payload: { body: 'two' }, idemKey: 'fin:m1' })
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
  const { db, alice } = await setup()
  for (let i = 1; i <= 5; i++) {
    append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: `m${i}` } })
  }
  const snap = snapshot(db, alice.id)
  assert.equal(snap.seq, 5)
  assert.equal(snap.conversations[0].unread_count, 5)
  // last_ts mirrors the newest event's ts so clients can render a correct
  // "last activity" time from a snapshot alone; NULL with no events.
  const newestTS = db.prepare("SELECT ts FROM events WHERE convo_id='c1' ORDER BY seq DESC LIMIT 1").get().ts
  assert.equal(snap.conversations[0].last_ts, newestTS)
  upsertConversation(db, { id: 'c-empty', ownerUserId: alice.id, title: 'no events yet' })
  const snap2 = snapshot(db, alice.id)
  assert.equal(snap2.conversations.find((c) => c.id === 'c-empty').last_ts, null)

  const replay = eventsAfter(db, alice.id, 2)
  assert.deepEqual(replay.map((e) => e.seq), [3, 4, 5])
  assert.equal(replay[0].payload.body, 'm3')

  const page = messagesBefore(db, alice.id, 'c1', { beforeSeq: 5, limit: 2 })
  assert.deepEqual(page.map((e) => e.seq), [3, 4])

  const rm = markRead(db, alice.id, 'c1', 4)
  assert.equal(rm.seq, 6) // read_marker is itself a journal event
  assert.equal(db.prepare("SELECT unread_count FROM conversations WHERE id='c1'").get().unread_count, 1)
  // sender must match the username format used by send/prompt_reply, not the numeric id
  assert.equal(db.prepare('SELECT sender FROM events WHERE seq=?').get(rm.seq).sender, 'user:alice')
})

test('messagesBefore rejects foreign convo', async () => {
  const { db } = await setup()
  const pat = await createUser(db, 'pat2', 'pw')
  assert.throws(() => messagesBefore(db, pat.id, 'c1', {}), /not authorized/)
})

test('a user-sender message does not bump unread; an agent-sender message does', async () => {
  const { db, alice } = await setup()
  const mine = append(db, { userId: alice.id, convoId: 'c1', sender: 'user:alice', type: 'text', payload: { body: 'mine' } })
  let c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 0)
  assert.equal(c1.last_seq, mine.seq)
  assert.equal(c1.snippet, 'mine') // snippet still tracks the latest message either way

  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: 'theirs' } })
  c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 1)
})

test('markRead with up_to_seq >= last_seq resets unread_count to 0', async () => {
  const { db, alice } = await setup()
  for (let i = 1; i <= 3; i++) {
    append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: `m${i}` } })
  }
  let c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 3)
  markRead(db, alice.id, 'c1', c1.last_seq)
  c1 = db.prepare("SELECT * FROM conversations WHERE id='c1'").get()
  assert.equal(c1.unread_count, 0)
})

test('markRead with up_to_seq null resolves server-side to the conversation head', async () => {
  const { db, alice } = await setup()
  for (let i = 1; i <= 3; i++) {
    append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: `m${i}` } })
  }
  const before = db.prepare("SELECT last_seq FROM conversations WHERE id='c1'").get()
  const r = markRead(db, alice.id, 'c1', null)
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
  const { db, alice } = await setup()
  const child = upsertConversation(db, { id: 'child', ownerUserId: alice.id, parentConvoId: 'c1' })
  assert.equal(child.parent_convo_id, 'c1')
  // c1 was created (in setup) without a parent -> null, not undefined.
  const c1 = db.prepare("SELECT parent_convo_id FROM conversations WHERE id='c1'").get()
  assert.equal(c1.parent_convo_id, null)
})

test('parent_convo_id is immutable: a later upsert cannot clear or change it', async () => {
  const { db, alice } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: alice.id, title: 'sub', parentConvoId: 'c1' })
  // later upsert WITHOUT the field must not clear it
  upsertConversation(db, { id: 'child', ownerUserId: alice.id, sessionState: 'waiting' })
  assert.equal(db.prepare("SELECT parent_convo_id FROM conversations WHERE id='child'").get().parent_convo_id, 'c1')
  // later upsert WITH a different value must not change it
  upsertConversation(db, { id: 'child', ownerUserId: alice.id, parentConvoId: 'c2' })
  assert.equal(db.prepare("SELECT parent_convo_id FROM conversations WHERE id='child'").get().parent_convo_id, 'c1')
  // a convo created WITHOUT a parent cannot gain one later either
  upsertConversation(db, { id: 'c1', ownerUserId: alice.id, parentConvoId: 'child' })
  assert.equal(db.prepare("SELECT parent_convo_id FROM conversations WHERE id='c1'").get().parent_convo_id, null)
})

test('snapshot rows carry parent_convo_id (null for normal convos, set for children)', async () => {
  const { db, alice } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: alice.id, title: 'sub', parentConvoId: 'c1' })
  const snap = snapshot(db, alice.id)
  assert.equal(snap.conversations.find((c) => c.id === 'c1').parent_convo_id, null)
  assert.equal(snap.conversations.find((c) => c.id === 'child').parent_convo_id, 'c1')
})

test('creating a titleless child still reports metaChanged so the linkage rides the journal', async () => {
  const { db, alice } = await setup()
  const child = upsertConversation(db, { id: 'child', ownerUserId: alice.id, parentConvoId: 'c1' })
  assert.equal(child.metaChanged, true, 'titleless child creation must fan out convo_meta')
  // Control: a titleless creation WITHOUT a parent stays silent, as before.
  const plain = upsertConversation(db, { id: 'plain', ownerUserId: alice.id })
  assert.equal(plain.metaChanged, false)
})

test('a partial markRead on a child convo cannot resurrect unread_count', async () => {
  const { db, alice } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: alice.id, parentConvoId: 'c1' })
  const first = append(db, { userId: alice.id, convoId: 'child', sender: 'agent:box-2', type: 'text', payload: { body: 'one' } })
  append(db, { userId: alice.id, convoId: 'child', sender: 'agent:box-2', type: 'text', payload: { body: 'two' } })
  // Reading only up to the first event leaves one agent message beyond
  // up_to_seq — the recompute must not count it for a silent child.
  markRead(db, alice.id, 'child', first.seq)
  assert.equal(db.prepare("SELECT unread_count FROM conversations WHERE id='child'").get().unread_count, 0)
})

test('a child convo (parent_convo_id set) never increments unread_count; the same event in a normal convo does', async () => {
  const { db, alice } = await setup()
  upsertConversation(db, { id: 'child', ownerUserId: alice.id, parentConvoId: 'c1' })
  append(db, { userId: alice.id, convoId: 'child', sender: 'agent:box-2', type: 'text', payload: { body: 'sub work' } })
  const child = db.prepare("SELECT unread_count, last_seq, snippet FROM conversations WHERE id='child'").get()
  assert.equal(child.unread_count, 0, 'silent child must not bump unread')
  // last_seq/snippet still track the event — only unread is exempt.
  assert.ok(child.last_seq > 0)
  assert.equal(child.snippet, 'sub work')
  // Control: the identical agent event in a normal convo DOES bump unread.
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: 'sub work' } })
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
  const { db, alice } = await setup()
  for (const badPayload of [null, undefined, {}, 'nope', 42, { state: 42 }]) {
    assert.throws(
      () => append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'session_status', payload: badPayload }),
      /invalid session_status payload/,
      `payload=${JSON.stringify(badPayload)}`
    )
  }
  // nothing landed, and the conversation's session_state is untouched
  assert.equal(db.prepare("SELECT COUNT(*) n FROM events WHERE type='session_status'").get().n, 0)
  assert.equal(db.prepare("SELECT session_state FROM conversations WHERE id='c1'").get().session_state, 'running')

  // a well-formed payload still works
  const r = append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'session_status', payload: { state: 'waiting' } })
  assert.ok(r.seq > 0)
  assert.equal(db.prepare("SELECT session_state FROM conversations WHERE id='c1'").get().session_state, 'waiting')
})

test('append with a MESSAGE_TYPES type and a null/non-object payload does not crash', async () => {
  const { db, alice } = await setup()
  assert.doesNotThrow(() => append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: null }))
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
  const alice = await createUser(db, 'alice', 'pw')
  const owner = createAgent(db, alice.id, 'dev-a')
  const guest = createAgent(db, alice.id, 'dev-b')
  const fresh = createAgent(db, alice.id, 'dev-c')
  upsertConversation(db, { id: 'room', ownerUserId: alice.id, title: 'room', sessionState: 'running', agentDeviceId: owner.deviceId })
  // Guest is a participant in ANY state (invited is enough — being invited
  // makes you categorically a guest).
  inviteParticipant(db, { convoId: 'room', agentDeviceId: guest.deviceId, initiatorDeviceId: owner.deviceId, justification: 'x' })
  upsertConversation(db, { id: 'room', ownerUserId: alice.id, sessionState: 'running', agentDeviceId: guest.deviceId })
  assert.equal(db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('room').agent_device_id, owner.deviceId)
  // A device with no participant row keeps the last-writer-wins takeover
  // (bridge re-pair reclaiming its own sessions under a new device id).
  upsertConversation(db, { id: 'room', ownerUserId: alice.id, sessionState: 'running', agentDeviceId: fresh.deviceId })
  assert.equal(db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get('room').agent_device_id, fresh.deviceId)
})

test('summary: set via upsert, kept when omitted, returned by snapshot', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const ag = createAgent(db, alice.id, 'dev-a')
  upsertConversation(db, { id: 's1', ownerUserId: alice.id, title: 't', sessionState: 'running', agentDeviceId: ag.deviceId, summary: 'debugging CI' })
  assert.equal(db.prepare('SELECT summary FROM conversations WHERE id=?').get('s1').summary, 'debugging CI')
  // Don't-clobber: an upsert without summary keeps the stored one (July
  // title-revert discipline).
  upsertConversation(db, { id: 's1', ownerUserId: alice.id, sessionState: 'running', agentDeviceId: ag.deviceId })
  assert.equal(db.prepare('SELECT summary FROM conversations WHERE id=?').get('s1').summary, 'debugging CI')
  upsertConversation(db, { id: 's1', ownerUserId: alice.id, agentDeviceId: ag.deviceId, summary: 'fixed CI, now on tests' })
  const snap = snapshot(db, alice.id)
  assert.equal(snap.conversations.find((c) => c.id === 's1').summary, 'fixed CI, now on tests')
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

test('contact_invite card snippet reads as an invite link request, like the native apps', () => {
  const s = snippetOf('permission_request', { kind: 'contact_invite', justification: 'SECRET-DO-NOT-LEAK' })
  assert.equal(s, '🤝 Invite link request')
  assert.ok(!s.includes('SECRET'))
})

test('last_ts counts message events only — status/meta/read_marker rows do not resurface a chat', async () => {
  const { db, alice } = await setup()
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'text', payload: { body: 'real message' } })
  const messageTS = db.prepare("SELECT ts FROM events WHERE convo_id='c1' ORDER BY seq DESC LIMIT 1").get().ts
  // Non-message rows land in `events` with fresh timestamps: the reaper's
  // session_status, membership/rename convo_meta fans, and read_marker
  // echoes. Stamp them well after the message to prove they are ignored —
  // append() stamps Date.now(), so push each row's ts forward directly.
  append(db, { userId: alice.id, convoId: 'c1', sender: 'agent:box-2', type: 'session_status', payload: { state: 'done' } })
  append(db, { userId: alice.id, convoId: 'c1', sender: 'journal', type: 'convo_meta', payload: { participants: [1, 2] } })
  markRead(db, alice.id, 'c1', 1)
  db.prepare("UPDATE events SET ts = ts + 3600000 WHERE convo_id='c1' AND type != 'text'").run()
  const snap = snapshot(db, alice.id)
  assert.equal(snap.conversations.find((c) => c.id === 'c1').last_ts, messageTS)
})

test('upsertConversation: repo is set, kept when absent, cleared with null, and rejected when malformed', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'alice', 'pw')
  const a = createAgent(db, u.id, 'box-2')
  let c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, title: 'C1', agentDeviceId: a.deviceId, repo: 'github.com/matronhq/matron-journal' })
  assert.equal(c.repo, 'github.com/matronhq/matron-journal')
  assert.equal(c.repo_scope, 'github.com/matronhq')
  assert.equal(c.metaChanged, true)
  c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId })
  assert.equal(c.repo, 'github.com/matronhq/matron-journal', 'absent leaves it alone')
  assert.equal(c.metaChanged, false)
  c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId, repo: 'github.com/matronhq/matron-journal' })
  assert.equal(c.metaChanged, false, 'same repo is not a change')
  c = upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId, repo: null })
  assert.equal(c.repo, null); assert.equal(c.repo_scope, null); assert.equal(c.metaChanged, true)
  assert.throws(() => upsertConversation(db, { id: 'c1', ownerUserId: u.id, agentDeviceId: a.deviceId, repo: 'GitHub.com/x/y' }), /bad repo/)
  db.close()
})

test('snapshot: conversations carry repo', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'alice', 'pw')
  const a = createAgent(db, u.id, 'box-2')
  upsertConversation(db, { id: 'c1', ownerUserId: u.id, title: 'C1', agentDeviceId: a.deviceId, repo: 'github.com/matronhq/x' })
  upsertConversation(db, { id: 'c2', ownerUserId: u.id, title: 'C2', agentDeviceId: a.deviceId })
  const snap = snapshot(db, u.id)
  const byId = Object.fromEntries(snap.conversations.map((c) => [c.id, c]))
  assert.equal(byId.c1.repo, 'github.com/matronhq/x')
  assert.equal(byId.c2.repo, null)
  db.close()
})

test('a silent event never counts as unread, at append or when a read recomputes the count', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'alice', 'pw')
  upsertConversation(db, { id: 'c1', ownerUserId: u.id })
  const first = append(db, { userId: u.id, convoId: 'c1', sender: 'agent:box-a', type: 'text', payload: { body: 'one' } }).seq
  append(db, { userId: u.id, convoId: 'c1', sender: 'agent:box-a', type: 'prompt', payload: { question: 'Reminder set', options: ['Send now', 'Cancel'], blocking: false, silent: true } })
  append(db, { userId: u.id, convoId: 'c1', sender: 'agent:box-a', type: 'text', payload: { body: 'two' } })
  // Only a strict true is silent.
  append(db, { userId: u.id, convoId: 'c1', sender: 'agent:box-a', type: 'text', payload: { body: 'three', silent: 1 } })
  const row = () => db.prepare("SELECT unread_count, snippet FROM conversations WHERE id='c1'").get()
  assert.equal(row().unread_count, 3)
  markRead(db, u.id, 'c1', first)
  assert.equal(row().unread_count, 2)
  // It is still content: the chat list shows it as the latest line.
  append(db, { userId: u.id, convoId: 'c1', sender: 'agent:box-a', type: 'prompt', payload: { question: 'Reminder set', options: [], silent: true } })
  assert.equal(row().unread_count, 2)
  assert.equal(row().snippet, '? Reminder set')
})

test('summary freshness: stamped on change only, null and identical resends keep it, legacy rows are 0, no event is appended', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const ag = createAgent(db, alice.id, 'box-a')
  const stamp = () => db.prepare('SELECT summary_updated_at t FROM conversations WHERE id=?').get('s1').t
  const bare = upsertConversation(db, { id: 's0', ownerUserId: alice.id, agentDeviceId: ag.deviceId })
  assert.equal(bare.summaryChanged, false)
  assert.equal(bare.summary_updated_at, 0)
  const created = upsertConversation(db, { id: 's1', ownerUserId: alice.id, agentDeviceId: ag.deviceId, summary: 'one' })
  assert.equal(created.summaryChanged, true)
  assert.equal(created.metaChanged, false, 'a summary alone is not a convo_meta')
  const t1 = stamp()
  assert.ok(t1 > 0)
  db.prepare('UPDATE conversations SET summary_updated_at=5 WHERE id=?').run('s1')
  for (const summary of ['one', null, undefined]) {
    const r = upsertConversation(db, { id: 's1', ownerUserId: alice.id, agentDeviceId: ag.deviceId, summary })
    assert.equal(r.summaryChanged, false)
    assert.equal(stamp(), 5)
  }
  const changed = upsertConversation(db, { id: 's1', ownerUserId: alice.id, agentDeviceId: ag.deviceId, summary: 'two' })
  assert.equal(changed.summaryChanged, true)
  assert.ok(stamp() > 5)
  const cleared = upsertConversation(db, { id: 's1', ownerUserId: alice.id, agentDeviceId: ag.deviceId, summary: '' })
  assert.equal(cleared.summaryChanged, true)
  assert.equal(cleared.summary, '')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM events').get().c, 0)
  const row = snapshot(db, alice.id).conversations.find((c) => c.id === 's1')
  assert.equal(row.summary_updated_at, stamp())
})
