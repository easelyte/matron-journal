import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation, snapshot } from '../src/journal.js'
import { startTestServer } from './helpers.js'

for (const surface of ['snapshot', '/roster']) {
  async function setup(t) {
    const s = surface === 'snapshot' ? { db: openDb(':memory:') } : await startTestServer()
    t.after(() => surface === 'snapshot' ? s.db.close() : s.close())
    const user = await createUser(s.db, 'alice', 'pw')
    const agent = createAgent(s.db, user.id, 'box')
    return {
      convo(id, createdAt = 0) {
        upsertConversation(s.db, { id, ownerUserId: user.id, title: id })
        s.db.prepare('UPDATE conversations SET created_at=? WHERE id=?').run(createdAt, id)
      },
      event(id, type, ts) {
        const event = append(s.db, {
          userId: user.id, convoId: id, sender: 'agent:box', type,
          payload: type === 'text' ? { body: id }
            : type === 'session_status' ? { state: 'waiting' } : {},
        })
        // Pin timestamps: real appends can share a millisecond.
        s.db.prepare('UPDATE events SET ts=? WHERE seq=?').run(ts, event.seq)
      },
      async rows() {
        if (surface === 'snapshot') return snapshot(s.db, user.id).conversations
        const res = await s.http(surface, { token: agent.token })
        assert.equal(res.status, 200)
        return res.json.conversations
      },
    }
  }

  test(`${surface}: non-message events do not resurface an idle conversation`, async (t) => {
    const s = await setup(t)
    s.convo('c-old')
    s.convo('c-new')
    s.event('c-old', 'text', 1000)
    s.event('c-new', 'text', 2000)
    for (const type of ['session_status', 'convo_meta', 'read_marker']) {
      s.event('c-old', type, 3000)
      const rows = await s.rows()
      assert.deepEqual(rows.map((c) => c.id), ['c-new', 'c-old'], type)
      assert.equal(rows[1].last_ts, 1000)
      assert.ok(rows[1].last_seq > rows[0].last_seq)
    }
    s.event('c-old', 'text', 4000)
    assert.deepEqual((await s.rows()).map((c) => c.id), ['c-old', 'c-new'])
  })

  test(`${surface}: equal message timestamps use immutable id descending`, async (t) => {
    const s = await setup(t)
    s.convo('c-b')
    s.convo('c-a')
    s.event('c-b', 'text', 1000)
    s.event('c-a', 'text', 1000)
    assert.deepEqual((await s.rows()).map((c) => c.id), ['c-b', 'c-a'])
    for (const type of ['session_status', 'convo_meta', 'read_marker']) {
      s.event('c-a', type, 2000)
      assert.deepEqual((await s.rows()).map((c) => c.id), ['c-b', 'c-a'], type)
    }
  })

  test(`${surface}: no messages falls back to created_at, then id`, async (t) => {
    const s = await setup(t)
    s.convo('c-empty-old', 100)
    s.convo('c-message', 999)
    s.convo('c-empty-a', 400)
    s.convo('c-empty-b', 400)
    s.event('c-message', 'text', 250)
    s.event('c-empty-old', 'convo_meta', 2000)
    const rows = await s.rows()
    assert.deepEqual(rows.map((c) => c.id), ['c-empty-b', 'c-empty-a', 'c-message', 'c-empty-old'])
    assert.deepEqual(rows.map((c) => c.last_ts), [null, null, 250, null])
  })
}
