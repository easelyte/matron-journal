import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'

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
})

test('append to unowned convo throws', async () => {
  const { db } = await setup()
  const pat = await createUser(db, 'pat', 'pw')
  assert.throws(
    () => append(db, { userId: pat.id, convoId: 'c1', sender: 'user:pat', type: 'text', payload: {} }),
    /not authorized/
  )
})
