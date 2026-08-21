import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation, snapshot } from '../src/journal.js'
import { startTestServer } from './helpers.js'

async function setup() {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  return { db, dan }
}

// A non-message event (session_status, convo_meta, read_marker) must NOT
// resurface a conversation ahead of one with a newer MESSAGE. Ordering is by
// last message time (COALESCE(last_ts, created_at)), not raw last_seq — which
// every meta/status event still advances. ts is pinned by hand because
// append() stamps Date.now() and two calls can land in the same millisecond.
test('snapshot orders by last message time; a later non-message event does not resurface a stale conversation', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'c-old', ownerUserId: dan.id, title: 'old' })
  upsertConversation(db, { id: 'c-new', ownerUserId: dan.id, title: 'new' })

  const oldMsg = append(db, { userId: dan.id, convoId: 'c-old', sender: 'agent:x', type: 'text', payload: { body: 'old' } })
  const newMsg = append(db, { userId: dan.id, convoId: 'c-new', sender: 'agent:x', type: 'text', payload: { body: 'new' } })
  db.prepare('UPDATE events SET ts=? WHERE seq=?').run(1000, oldMsg.seq)
  db.prepare('UPDATE events SET ts=? WHERE seq=?').run(2000, newMsg.seq)

  // A later, higher-seq, newer-ts NON-message event on the OLDER conversation.
  const status = append(db, { userId: dan.id, convoId: 'c-old', sender: 'agent:x', type: 'session_status', payload: { state: 'waiting' } })
  db.prepare('UPDATE events SET ts=? WHERE seq=?').run(3000, status.seq)

  const snap = snapshot(db, dan.id)
  // c-old has the highest last_seq (its status event) but its last MESSAGE is
  // older than c-new's, so it must sort BELOW c-new. Under ORDER BY last_seq
  // DESC this asserted the reverse (the bug).
  assert.deepEqual(snap.conversations.map((c) => c.id), ['c-new', 'c-old'])
  // last_ts tracks message events only: the status event did not advance it.
  assert.equal(snap.conversations.find((c) => c.id === 'c-old').last_ts, 1000)
})

// Same-millisecond last_ts collision: append() stamps Date.now(), so two
// conversations' newest messages can share a ts. The tie-break must be the
// immutable id, NOT last_seq — a last_seq tie-break would let a later
// non-message event (which still advances last_seq) resurface the stale
// conversation on the tie, reintroducing the exact bug. Proof: ordering is
// unchanged by a status event on a tied conversation.
test('snapshot: a non-message event never reorders conversations tied on last_ts', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'c-x', ownerUserId: dan.id, title: 'x' })
  upsertConversation(db, { id: 'c-y', ownerUserId: dan.id, title: 'y' })
  const mx = append(db, { userId: dan.id, convoId: 'c-x', sender: 'agent:x', type: 'text', payload: { body: 'x' } })
  const my = append(db, { userId: dan.id, convoId: 'c-y', sender: 'agent:x', type: 'text', payload: { body: 'y' } })
  // Identical last message timestamps (the collision case).
  db.prepare('UPDATE events SET ts=? WHERE seq=?').run(5000, mx.seq)
  db.prepare('UPDATE events SET ts=? WHERE seq=?').run(5000, my.seq)

  const before = snapshot(db, dan.id).conversations.map((c) => c.id)
  // Fire a non-message event on whichever conversation currently sorts LAST —
  // under a last_seq tie-break it would jump to the top; under id it must not.
  const laggard = before[before.length - 1]
  const status = append(db, { userId: dan.id, convoId: laggard, sender: 'agent:x', type: 'session_status', payload: { state: 'waiting' } })
  db.prepare('UPDATE events SET ts=? WHERE seq=?').run(6000, status.seq)

  const after = snapshot(db, dan.id).conversations.map((c) => c.id)
  assert.deepEqual(after, before)
})

// A conversation with zero message events falls back to created_at for its slot.
test('snapshot places message-less conversations by created_at', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'c-msg', ownerUserId: dan.id, title: 'has message' })
  upsertConversation(db, { id: 'c-empty-newer', ownerUserId: dan.id, title: 'newer empty' })
  upsertConversation(db, { id: 'c-empty-older', ownerUserId: dan.id, title: 'older empty' })
  db.prepare("UPDATE conversations SET created_at=? WHERE id='c-empty-older'").run(100)
  db.prepare("UPDATE conversations SET created_at=? WHERE id='c-empty-newer'").run(400)

  const m = append(db, { userId: dan.id, convoId: 'c-msg', sender: 'agent:x', type: 'text', payload: { body: 'hi' } })
  db.prepare('UPDATE events SET ts=? WHERE seq=?').run(250, m.seq)
  db.prepare("UPDATE conversations SET created_at=? WHERE id='c-msg'").run(999)

  const snap = snapshot(db, dan.id)
  const ids = snap.conversations.map((c) => c.id)
  // c-empty-newer (created_at 400) > c-msg (last_ts 250, created_at ignored) >
  // c-empty-older (created_at 100). Proves last message time wins over the
  // convo's own created_at, and empties are ordered by created_at.
  assert.deepEqual(ids, ['c-empty-newer', 'c-msg', 'c-empty-older'])
})

// Two message-less conversations minted in the same millisecond share created_at
// and both have last_seq 0 — the id tie-break gives them a total, stable order
// (no SQLite-plan-dependent flicker).
test('snapshot orders identical-created_at message-less conversations deterministically by id', async () => {
  const { db, dan } = await setup()
  upsertConversation(db, { id: 'c-aaa', ownerUserId: dan.id, title: 'a' })
  upsertConversation(db, { id: 'c-bbb', ownerUserId: dan.id, title: 'b' })
  db.prepare("UPDATE conversations SET created_at=7000 WHERE id IN ('c-aaa','c-bbb')").run()

  const ids = snapshot(db, dan.id).conversations.map((c) => c.id)
  // id DESC → 'c-bbb' before 'c-aaa'; must be identical across repeated reads.
  assert.deepEqual(ids, ['c-bbb', 'c-aaa'])
  assert.deepEqual(snapshot(db, dan.id).conversations.map((c) => c.id), ids)
})

// The same ordering must hold on the /roster HTTP surface (its SQL is a second
// copy of the same query and drives agent-chat targeting order).
test('GET /roster orders conversations by last message time, not last_seq', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const agent = createAgent(s.db, dan.id, 'box')
  upsertConversation(s.db, { id: 'r-old', ownerUserId: dan.id, title: 'old' })
  upsertConversation(s.db, { id: 'r-new', ownerUserId: dan.id, title: 'new' })

  const oldMsg = append(s.db, { userId: dan.id, convoId: 'r-old', sender: 'agent:box', type: 'text', payload: { body: 'old' } })
  const newMsg = append(s.db, { userId: dan.id, convoId: 'r-new', sender: 'agent:box', type: 'text', payload: { body: 'new' } })
  s.db.prepare('UPDATE events SET ts=? WHERE seq=?').run(1000, oldMsg.seq)
  s.db.prepare('UPDATE events SET ts=? WHERE seq=?').run(2000, newMsg.seq)
  const status = append(s.db, { userId: dan.id, convoId: 'r-old', sender: 'agent:box', type: 'session_status', payload: { state: 'waiting' } })
  s.db.prepare('UPDATE events SET ts=? WHERE seq=?').run(3000, status.seq)

  const res = await s.http('/roster', { token: agent.token })
  assert.equal(res.status, 200)
  assert.deepEqual(res.json.conversations.map((c) => c.id), ['r-new', 'r-old'])
})
