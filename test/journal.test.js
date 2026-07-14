import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { append, upsertConversation, snapshot, eventsAfter, messagesBefore, markRead, snippetOf } from '../src/journal.js'

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
