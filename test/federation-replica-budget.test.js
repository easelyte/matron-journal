import { test } from 'node:test'
import assert from 'node:assert/strict'
import { signEnvelope, newOpId } from '../src/federation-envelope.js'
import { applyEvent, replicaBytes, ITEM_RECORD_MAX } from '../src/federation-replica.js'
import { world, offer, post } from './federation-world.js'

const raw = (s, envelope) => fetch(s.base + '/federation/v1', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(envelope) })
  .then(async (r) => ({ status: r.status, json: await r.json() }))

async function sharedWorld(t) {
  const w = await world(t)
  const grant = await offer(w)
  const fg = w.b.db.prepare('SELECT * FROM fed_grants_in').get()
  assert.equal((await w.phones.bob(`/grants/${fg.id}/answer`, post({ decision: 'approve' }))).status, 200)
  await w.settle()
  return { w, grant, fg: w.b.db.prepare('SELECT * FROM fed_grants_in').get() }
}

const item = (i, body, comments = []) => ({ ref: `it_big${i}`, num: 100 + i, kind: 'task', state: 'open', title: `Item ${i}`, body, created_at: 1, updated_at: 1 + i, comments })

test('an item record larger than any the owner journal sends is refused 413 too_large', async (t) => {
  const { w, grant, fg } = await sharedWorld(t)
  const comments = Array.from({ length: 20 }, (_, j) => ({ ref: `ic_c${j}`, author: 'user', kind: 'comment', body: 'x'.repeat(30000), created_at: 1 }))
  const record = item(1, 'x'.repeat(30000), comments)
  assert.ok(JSON.stringify(record).length > ITEM_RECORD_MAX)
  const r = await raw(w.b, signEnvelope({
    from: 'alice@a.example', to: 'bob@b.example', op: 'mission.event', id: newOpId(),
    body: { grant: grant.id, sent: fg.offer_sent, kind: 'item', ref: record.ref, record },
  }, w.a.federation.key.privateKey))
  assert.deepEqual([r.status, r.json], [413, { error: 'too_large' }])
  assert.equal(w.b.db.prepare("SELECT COUNT(*) AS n FROM fed_replica_items WHERE ref='it_big1'").get().n, 0)
})

test('a copy stops growing at its budget: the event that would pass it is refused and changes nothing', async (t) => {
  const { w, fg } = await sharedWorld(t)
  const d = w.b.db
  const maxBytes = 200_000
  const apply = (i) => d.transaction(() => applyEvent(d, fg, { grant: fg.peer_grant_ref, sent: fg.offer_sent, kind: 'item', ref: `it_big${i}`, record: item(i, 'y'.repeat(30000)) }, { maxBytes }))()
  let i = 0
  for (; i < 100; i++) {
    try { apply(i) } catch (err) { assert.equal(err.message, 'replica_full'); break }
  }
  assert.ok(i > 0 && i < 100, `refused after ${i} events`)
  assert.ok(replicaBytes(d, fg.id) <= maxBytes)
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM fed_replica_items WHERE ref=?').get(`it_big${i}`).n, 0, 'the refused event left nothing')
  // A smaller state of a record already there still applies: the copy can shrink.
  d.transaction(() => applyEvent(d, fg, { grant: fg.peer_grant_ref, sent: fg.offer_sent, kind: 'item', ref: 'it_big0', record: item(0, 'small') }, { maxBytes }))()
})

test('a snapshot with no room here is given up, not left waiting: staged pages go, the owner hears', async (t) => {
  const { w, grant, fg } = await sharedWorld(t)
  const key = w.a.federation.key.privateKey
  const send = (page, pages, items) => raw(w.b, signEnvelope({
    from: 'alice@a.example', to: 'bob@b.example', op: 'mission.snapshot', id: newOpId(),
    body: { grant: grant.id, snap: 'sn_big', page, pages, ...(page === 0 ? { mission: { num: 1, title: 'Garden Club', state: 'open', created_at: 1, updated_at: 1 } } : {}), milestones: [], items },
  }, key))
  assert.equal((await send(0, 2, [item(1, 'fine')])).status, 200)
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_replica_pages').get().n, 1)
  // The last page carries a record too large to keep.
  const comments = Array.from({ length: 20 }, (_, j) => ({ ref: `ic_c${j}`, author: 'user', kind: 'comment', body: 'x'.repeat(30000), created_at: 1 }))
  const r = await send(1, 2, [item(2, 'x', comments)])
  assert.deepEqual([r.status, r.json.result], [200, { refused: 'too_large' }])
  assert.equal(w.b.db.prepare('SELECT COUNT(*) AS n FROM fed_replica_pages').get().n, 0, 'nothing left staged')
  assert.equal(w.b.db.prepare("SELECT COUNT(*) AS n FROM fed_replica_items WHERE ref='it_big2'").get().n, 0)
})

test('the owner is told when its snapshot was given up for want of room', async (t) => {
  const { w, grant } = await sharedWorld(t)
  const { makeGrantFederation } = await import('../src/federation-grants.js')
  const gf = makeGrantFederation({ db: w.a.db, federation: w.a.federation })
  const entry = { body: JSON.stringify({ grant: grant.id, snap: 'sn_x' }) }
  const after = gf.outbound['mission.snapshot'].onAcked(w.a.db, entry, { refused: 'replica_full' })
  after()
  const n = w.a.db.prepare("SELECT title, body FROM items WHERE user_id=? AND kind='notice' AND title LIKE 'Couldn''t send mission%'").all(w.users.alice.id)
  assert.equal(n.length, 1)
  assert.match(n[0].body, /no more room/)
})

test('an oversized page of a snapshot no longer loading gives up nothing that is', async (t) => {
  const { w, grant } = await sharedWorld(t)
  const key = w.a.federation.key.privateKey
  const send = (snap, page, pages, items) => raw(w.b, signEnvelope({
    from: 'alice@a.example', to: 'bob@b.example', op: 'mission.snapshot', id: newOpId(),
    body: { grant: grant.id, snap, page, pages, ...(page === 0 ? { mission: { num: 1, title: 'Garden Club', state: 'open', created_at: 1, updated_at: 1 } } : {}), milestones: [], items },
  }, key))
  assert.equal((await send('sn_now', 0, 3, [item(1, 'fine')])).status, 200)
  const comments = Array.from({ length: 20 }, (_, j) => ({ ref: `ic_c${j}`, author: 'user', kind: 'comment', body: 'x'.repeat(30000), created_at: 1 }))
  const r = await send('sn_old', 1, 3, [item(2, 'x', comments)])
  assert.deepEqual(r.json.result, { refused: 'too_large' })
  assert.equal(w.b.db.prepare("SELECT COUNT(*) AS n FROM fed_replica_pages WHERE snap='sn_now'").get().n, 1, 'the loading snapshot is untouched')
})
