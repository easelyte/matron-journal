import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, setApnsRegistration } from '../src/db.js'
import { makeHub } from '../src/hub.js'
import { makePushPipeline, pushContent, freshItemEvent } from '../src/push.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { createItem } from '../src/items.js'

function stubApns() {
  const calls = []
  return { calls, send(opts) { calls.push(opts); return Promise.resolve({ status: 200, reason: null }) } }
}

const wait = (ms) => new Promise((res) => setTimeout(res, ms))

// Alice with one agent session ('work') and one phone; item pushes held for
// `holdMs`.
async function setup(t, { holdMs = 60 } = {}) {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  const box = createAgent(db, alice.id, 'box-a').deviceId
  upsertConversation(db, { id: 'work', ownerUserId: alice.id, title: 'Some work', agentDeviceId: box })
  db.prepare('UPDATE conversations SET agent_device_id=? WHERE id=?').run(box, 'work')
  const stub = stubApns()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub, coalesceMs: 20, itemHoldMs: holdMs })
  t.after(() => pipeline.close())
  const phone = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client','phone','phone-hash',?)")
    .run(alice.id, Date.now()).lastInsertRowid
  setApnsRegistration(db, phone, { apnsToken: 'phone-token', apnsEnv: 'prod' })
  const file = (title = 'Ship it?') => createItem(db, { userId: alice.id, kind: 'question', title, awaiting: 'user', originConvoId: 'work', originDeviceId: box, createdBy: 'agent' }).item
  const marker = (item, action = 'created') => {
    const payload = { action, item_id: item.id, num: item.num, kind: item.kind, title: item.title, awaiting: 'user', by: 'agent' }
    const r = append(db, { userId: alice.id, convoId: 'work', sender: 'agent:box-a', type: 'item', payload })
    return { seq: r.seq, convo_id: 'work', ts: r.ts, sender: 'agent:box-a', type: 'item', payload }
  }
  const emit = (item, action) => {
    const event = marker(item, action)
    pipeline.onAppend(alice.id, event, null)
    return event
  }
  return { db, alice, phone, stub, pipeline, file, marker, emit }
}

test('item hold: a question still awaiting the user pushes once the hold ends, not before', async (t) => {
  const ctx = await setup(t)
  ctx.emit(ctx.file())
  await wait(10)
  assert.equal(ctx.stub.calls.length, 0, 'held')
  await wait(90)
  assert.equal(ctx.stub.calls.length, 1)
  assert.equal(ctx.stub.calls[0].category, 'attention')
})

test('item hold: an item closed or handed back to an agent within the hold never pushes', async (t) => {
  const ctx = await setup(t)
  const closed = ctx.file('closed')
  const handed = ctx.file('handed back')
  ctx.emit(closed)
  ctx.emit(handed)
  ctx.db.prepare("UPDATE items SET state='closed', resolution='answered', awaiting=NULL WHERE id=?").run(closed.id)
  ctx.db.prepare("UPDATE items SET awaiting='agent' WHERE id=?").run(handed.id)
  await wait(120)
  assert.equal(ctx.stub.calls.length, 0)
})

test('item hold: a phone that caught up during the hold gets nothing', async (t) => {
  const ctx = await setup(t)
  const event = ctx.emit(ctx.file())
  ctx.db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(event.seq, ctx.phone)
  await wait(120)
  assert.equal(ctx.stub.calls.length, 0)
})

test('item hold: 0 sends at once; pushes that are not about an item are never held', async (t) => {
  const ctx = await setup(t, { holdMs: 0 })
  ctx.emit(ctx.file())
  await wait(5)
  assert.equal(ctx.stub.calls.length, 1, 'no hold')
  const held = await setup(t)
  const r = append(held.db, { userId: held.alice.id, convoId: 'work', sender: 'agent:box-a', type: 'prompt', payload: { question: 'go?' } })
  held.pipeline.onAppend(held.alice.id, { seq: r.seq, convo_id: 'work', ts: r.ts, sender: 'agent:box-a', type: 'prompt', payload: { question: 'go?' } }, null)
  await wait(5)
  assert.equal(held.stub.calls.length, 1, 'a prompt goes at once')
})

test('resumeHeldItems: after a restart, a recent item still awaiting the user gets its push; a closed or consent one does not', async (t) => {
  const ctx = await setup(t, { holdMs: 30 })
  const open = ctx.file('open')
  const closed = ctx.file('closed')
  ctx.marker(open)
  ctx.marker(closed)
  ctx.db.prepare("UPDATE items SET state='closed', resolution='answered', awaiting=NULL WHERE id=?").run(closed.id)
  const mirror = ctx.file('consent')
  append(ctx.db, { userId: ctx.alice.id, convoId: 'work', sender: 'agent:box-a', type: 'item', payload: { action: 'created', item_id: mirror.id, kind: 'question', title: 'consent', awaiting: 'user', by: 'agent', consent: 'spawn' } })
  assert.equal(ctx.pipeline.resumeHeldItems(), 1)
  await wait(60)
  assert.equal(ctx.stub.calls.length, 1)
  assert.equal(ctx.pipeline.resumeHeldItems(Date.now() + 5 * 60 * 1000), 0, 'its hold long over: it already pushed before the restart')
})

test('resumeHeldItems: nothing to resume when items are not held', async (t) => {
  const ctx = await setup(t, { holdMs: 0 })
  ctx.marker(ctx.file())
  assert.equal(ctx.pipeline.resumeHeldItems(), 0)
})

test('resumeHeldItems: the startup read uses the partial index, not a full events scan', () => {
  const db = openDb(':memory:')
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT user_id, seq FROM events WHERE type='item' AND ts > ?").all(0).map((r) => r.detail).join(' ')
  assert.match(plan, /idx_events_item/)
})

test('item hold: only the newest held push for an item goes out', async (t) => {
  const ctx = await setup(t)
  const item = ctx.file()
  ctx.emit(item)
  await wait(20)
  ctx.emit(item, 'commented')
  await wait(150)
  assert.equal(ctx.stub.calls.length, 1)
})

test('item hold: the push offers the buttons the item has when it is sent', async (t) => {
  const ctx = await setup(t)
  const item = ctx.file()
  ctx.db.prepare(`UPDATE items SET actions='["Wait"]' WHERE id=?`).run(item.id)
  const event = ctx.marker(item)
  event.payload.actions = ['Ship']
  const convo = { id: 'work', title: 'Some work' }
  const cls = { kind: 'attention', question: true }
  assert.deepEqual(pushContent(freshItemEvent(ctx.db, ctx.alice.id, event), convo, cls).item.actions, ['Wait'])
  ctx.db.prepare(`UPDATE items SET chosen_action='Wait' WHERE id=?`).run(item.id)
  assert.deepEqual(pushContent(freshItemEvent(ctx.db, ctx.alice.id, event), convo, cls).item.actions, [], 'tapped: no buttons')
})

test('resumeHeldItems: the newest marker for an item wins, whatever order they are read in', async (t) => {
  const ctx = await setup(t, { holdMs: 30 })
  const item = ctx.file()
  ctx.marker(item)
  const newer = ctx.marker(item, 'commented')
  ctx.pipeline.resumeHeldItems()
  ctx.pipeline.onAppend(ctx.alice.id, ctx.marker(item, 'created'), null) // arrives later with a higher seq
  ctx.db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(newer.seq, ctx.phone)
  await wait(80)
  assert.equal(ctx.stub.calls.length, 1, 'only the highest seq goes out')
})

test('item hold: an older marker arriving late does not replace a newer held one', async (t) => {
  const ctx = await setup(t)
  const item = ctx.file()
  const older = ctx.marker(item)
  const newer = ctx.marker(item, 'commented')
  ctx.pipeline.onAppend(ctx.alice.id, newer, null)
  ctx.pipeline.onAppend(ctx.alice.id, older, null)
  ctx.db.prepare('UPDATE devices SET cursor=? WHERE id=?').run(older.seq, ctx.phone)
  await wait(120)
  assert.equal(ctx.stub.calls.length, 1, 'the newer one still goes out')
})
