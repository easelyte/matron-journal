import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb, setApnsRegistration } from '../src/db.js'
import { makeHub } from '../src/hub.js'
import { makePushPipeline } from '../src/push.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation, append } from '../src/journal.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { setConsentEnabled } from '../src/consent.js'
import { createSpawnRequest } from '../src/spawns.js'
import { createItem } from '../src/items.js'
import {
  parseNotifyPrefs, getNotifyPrefs, setNotifyPrefs, setConvoNotify, setDeviceLevel, notifyView,
} from '../src/notify.js'
import { startTestServer, makeWsClient } from './helpers.js'

function stubApns() {
  const calls = []
  return { calls, send(opts) { calls.push(opts); return Promise.resolve({ status: 200, reason: null }) } }
}

function registerDevice(db, userId, name) {
  const id = db.prepare("INSERT INTO devices(user_id, kind, name, token_hash, created_at) VALUES(?,'client',?,?,?)")
    .run(userId, name, `${name}-hash`, Date.now()).lastInsertRowid
  setApnsRegistration(db, id, { apnsToken: `${name}-token`, apnsEnv: 'prod' })
  return id
}

const tick = () => new Promise((res) => setTimeout(res, 5))

// Alice with a Coordinator conversation ('coord', owned by box `coordBox`), an
// ordinary session ('work', owned by box `workBox`) and one phone.
async function setup(t, opts = {}) {
  const db = openDb(':memory:')
  const hub = makeHub()
  const alice = await createUser(db, 'alice', 'pw')
  const coordBox = createAgent(db, alice.id, 'coord-box').deviceId
  const workBox = createAgent(db, alice.id, 'work-box').deviceId
  upsertConversation(db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: coordBox })
  upsertConversation(db, { id: 'work', ownerUserId: alice.id, title: 'Some work', agentDeviceId: workBox })
  db.prepare('UPDATE conversations SET agent_device_id=? WHERE id=?').run(coordBox, 'coord')
  db.prepare('UPDATE conversations SET agent_device_id=? WHERE id=?').run(workBox, 'work')
  if (opts.coordinator !== false) setCoordinatorConvoId(db, alice.id, 'coord', Date.now())
  const stub = stubApns()
  const pipeline = makePushPipeline({ db, hub, apnsClient: stub, coalesceMs: 20, consentHoldMs: opts.holdMs ?? 40 })
  t.after(() => pipeline.close())
  const phone = registerDevice(db, alice.id, 'phone')
  const emit = (convoId, type, payload, hint) => {
    const r = append(db, { userId: alice.id, convoId, sender: 'agent:box', type, payload })
    pipeline.onAppend(alice.id, { seq: r.seq, convo_id: convoId, ts: r.ts, sender: 'agent:box', type, payload }, null, hint)
    return r
  }
  const finish = (convoId, state = 'waiting') => emit(convoId, 'session_status', { state }, { prevSessionState: 'running' })
  return { db, hub, alice, stub, pipeline, phone, emit, finish, coordBox, workBox }
}

test('defaults: Coordinator mode, every switch at its preset; unreadable JSON falls back', () => {
  assert.deepEqual(parseNotifyPrefs(null), {
    mode: 'coordinator',
    events: { prompts: true, questions: true, notices: true, coordinator_done: false, other_done: false, stopped: false, rooms: false, activity: false },
  })
  assert.equal(parseNotifyPrefs('{nope').mode, 'coordinator')
  assert.equal(parseNotifyPrefs('{"mode":"weird"}').mode, 'coordinator')
  assert.equal(parseNotifyPrefs('{"mode":"all"}').events.other_done, true)
})

test('setNotifyPrefs: switching an event on a preset moves to custom from that preset; prompts never go off', async () => {
  const db = openDb(':memory:')
  const alice = await createUser(db, 'alice', 'pw')
  const out = setNotifyPrefs(db, alice.id, { events: { rooms: true, prompts: false } })
  assert.equal(out.mode, 'custom')
  assert.equal(out.events.rooms, true)
  assert.equal(out.events.prompts, true)
  assert.equal(out.events.other_done, false, 'custom starts from the Coordinator preset it left')
  assert.equal(setNotifyPrefs(db, alice.id, { mode: 'all' }).events.rooms, false)
  assert.equal(getNotifyPrefs(db, alice.id).mode, 'all')
})

test('Coordinator mode: no session finishing or stopping pushes, the Coordinator included', async (t) => {
  const { stub, finish } = await setup(t)
  finish('work')
  finish('work', 'done')
  finish('coord')
  finish('coord', 'done')
  await tick()
  assert.equal(stub.calls.length, 0)
})

test('Coordinator mode: switching "Coordinator finished a turn" back on pushes its turns again', async (t) => {
  const { db, alice, stub, finish } = await setup(t)
  assert.equal(setNotifyPrefs(db, alice.id, { events: { coordinator_done: true } }).mode, 'custom')
  finish('work')
  finish('coord')
  await tick()
  assert.equal(stub.calls.length, 1)
  assert.equal(stub.calls[0].payload['aps']['thread-id'], 'coord')
})

test('Coordinator mode: prompts, permission prompts and items awaiting the user still push from any session', async (t) => {
  const { stub, emit } = await setup(t)
  emit('work', 'prompt', { question: 'go?' })
  emit('work', 'permission_request', { description: 'write file' })
  emit('work', 'item', { action: 'created', awaiting: 'user', by: 'agent', item: { num: 1 } })
  await tick()
  assert.equal(stub.calls.length, 3)
})

test('Coordinator mode with no Coordinator set behaves as every-session', async (t) => {
  const { stub, finish } = await setup(t, { coordinator: false })
  finish('work')
  await tick()
  assert.equal(stub.calls.length, 1)
})

test('"all" mode: every session finishing and stopping pushes; room and activity stay off', async (t) => {
  const { db, alice, stub, finish, emit } = await setup(t)
  setNotifyPrefs(db, alice.id, { mode: 'all' })
  finish('work')
  finish('work', 'done')
  emit('work', 'text', { body: 'chatter' })
  await tick()
  assert.equal(stub.calls.length, 2)
})

test('rooms: a joined room\'s messages follow the rooms switch, not activity', async (t) => {
  const { db, alice, stub, emit, workBox } = await setup(t)
  upsertConversation(db, { id: 'room', ownerUserId: alice.id, title: 'room' })
  db.prepare("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('room',?,?,'joined',?)").run(workBox, workBox, Date.now())
  setNotifyPrefs(db, alice.id, { mode: 'custom', events: { activity: true } })
  emit('room', 'text', { body: 'hi room' })
  await tick()
  assert.equal(stub.calls.length, 0, 'activity on does not open rooms')
  setNotifyPrefs(db, alice.id, { events: { rooms: true } })
  emit('room', 'text', { body: 'hi again' })
  await tick()
  assert.equal(stub.calls.length, 1)
})

test('per conversation: "all" beats Coordinator mode, "needs_me" drops turns, "none" and a mute drop everything', async (t) => {
  const { db, alice, stub, finish, emit } = await setup(t)
  setConvoNotify(db, alice.id, 'work', { level: 'all' })
  finish('work')
  await tick()
  assert.equal(stub.calls.length, 1, 'all: the watched session pushes its turns')

  setConvoNotify(db, alice.id, 'coord', { level: 'needs_me' })
  finish('coord')
  emit('coord', 'prompt', { question: '?' })
  await tick()
  assert.equal(stub.calls.length, 2, 'needs_me: the prompt only')

  setConvoNotify(db, alice.id, 'work', { level: 'none' })
  emit('work', 'permission_request', { description: 'x' })
  await tick()
  assert.equal(stub.calls.length, 2, 'none: even a permission prompt is silent')

  setConvoNotify(db, alice.id, 'work', { level: null, mute_until: Date.now() + 60000 })
  emit('work', 'prompt', { question: '?' })
  await tick()
  assert.equal(stub.calls.length, 2, 'muted')

  setConvoNotify(db, alice.id, 'work', { mute_until: Date.now() - 1 })
  emit('work', 'prompt', { question: '?' })
  await tick()
  assert.equal(stub.calls.length, 3, 'an expired mute is no mute')
})

test('per device: "off" gets nothing, "needs_me" only prompts and questions', async (t) => {
  const { db, stub, phone, emit, finish } = await setup(t)
  setDeviceLevel(db, phone, 'needs_me')
  finish('coord')
  emit('work', 'prompt', { question: '?' })
  await tick()
  assert.equal(stub.calls.length, 1)
  setDeviceLevel(db, phone, 'off')
  emit('work', 'prompt', { question: '?' })
  await tick()
  assert.equal(stub.calls.length, 1)
})

function spawnCard(t, ctx, { fromDeviceId, id = 'sp1' } = {}) {
  createSpawnRequest(ctx.db, { id, userId: ctx.alice.id, fromDeviceId, fromConvoId: 'work', targetDeviceId: ctx.workBox, workdir: '/w', task: 't' })
  return ctx.emit('work', 'permission_request', { kind: 'agent_spawn', request_id: id, from_device_id: fromDeviceId })
}

test('consent hold: a spawn card the Coordinator decides within the hold never pushes', async (t) => {
  const ctx = await setup(t, { holdMs: 300 })
  spawnCard(t, ctx, { fromDeviceId: ctx.workBox })
  assert.equal(ctx.stub.calls.length, 0, 'held')
  ctx.db.prepare("UPDATE agent_spawn_requests SET state='approved' WHERE id='sp1'").run()
  await new Promise((res) => setTimeout(res, 400))
  assert.equal(ctx.stub.calls.length, 0)
})

test('consent hold: a spawn card still pending after the hold pushes then', async (t) => {
  const ctx = await setup(t)
  spawnCard(t, ctx, { fromDeviceId: ctx.workBox })
  await new Promise((res) => setTimeout(res, 60))
  assert.equal(ctx.stub.calls.length, 1)
})

test('consent hold: none for the Coordinator\'s own ask, with consent off, or outside Coordinator mode', async (t) => {
  const ctx = await setup(t)
  spawnCard(t, ctx, { fromDeviceId: ctx.coordBox, id: 'own' })
  await tick()
  assert.equal(ctx.stub.calls.length, 1, 'own ask: at once')
  setConsentEnabled(ctx.db, ctx.alice.id, false, Date.now())
  spawnCard(t, ctx, { fromDeviceId: ctx.workBox, id: 'off' })
  await tick()
  assert.equal(ctx.stub.calls.length, 2, 'consent off: at once')
  setConsentEnabled(ctx.db, ctx.alice.id, true, Date.now())
  setNotifyPrefs(ctx.db, ctx.alice.id, { mode: 'all' })
  spawnCard(t, ctx, { fromDeviceId: ctx.workBox, id: 'all' })
  await tick()
  assert.equal(ctx.stub.calls.length, 3, 'every-session mode: at once')
})

test('consent hold: a chat invite card is held and skipped once answered', async (t) => {
  const ctx = await setup(t)
  upsertConversation(ctx.db, { id: 'room', ownerUserId: ctx.alice.id, title: 'room' })
  ctx.db.prepare("INSERT INTO convo_agents(convo_id, agent_device_id, initiator_device_id, state, created_at) VALUES('room',?,?,'awaiting_user',?)").run(ctx.coordBox, ctx.workBox, Date.now())
  ctx.emit('room', 'permission_request', { kind: 'agent_chat', request: 'invite', room_id: 'room', from_device_id: ctx.workBox, target_device_id: ctx.coordBox })
  ctx.db.prepare("UPDATE convo_agents SET state='invited' WHERE convo_id='room'").run()
  await new Promise((res) => setTimeout(res, 120))
  assert.equal(ctx.stub.calls.length, 0)
})

test('resumeHeldConsent: after a restart, a recent ask still pending gets its push; a decided one does not', async (t) => {
  const ctx = await setup(t, { holdMs: 0 })
  createSpawnRequest(ctx.db, { id: 'p', userId: ctx.alice.id, fromDeviceId: ctx.workBox, fromConvoId: 'work', targetDeviceId: ctx.workBox, workdir: '/w', task: 't' })
  createSpawnRequest(ctx.db, { id: 'd', userId: ctx.alice.id, fromDeviceId: ctx.workBox, fromConvoId: 'work', targetDeviceId: ctx.workBox, workdir: '/w', task: 't' })
  ctx.db.prepare("UPDATE agent_spawn_requests SET state='denied' WHERE id='d'").run()
  for (const id of ['p', 'd']) append(ctx.db, { userId: ctx.alice.id, convoId: 'work', sender: 'agent:box', type: 'permission_request', payload: { kind: 'agent_spawn', request_id: id, from_device_id: ctx.workBox } })
  assert.equal(ctx.pipeline.resumeHeldConsent(), 1)
  await new Promise((res) => setTimeout(res, 20))
  assert.equal(ctx.stub.calls.length, 1)
})

test('resumeHeldConsent: never re-pushes an ask that was not held (every-session mode) or is older than its hold', async (t) => {
  const ctx = await setup(t, { holdMs: 0 })
  setNotifyPrefs(ctx.db, ctx.alice.id, { mode: 'all' })
  createSpawnRequest(ctx.db, { id: 'p', userId: ctx.alice.id, fromDeviceId: ctx.workBox, fromConvoId: 'work', targetDeviceId: ctx.workBox, workdir: '/w', task: 't' })
  append(ctx.db, { userId: ctx.alice.id, convoId: 'work', sender: 'agent:box', type: 'permission_request', payload: { kind: 'agent_spawn', request_id: 'p', from_device_id: ctx.workBox } })
  assert.equal(ctx.pipeline.resumeHeldConsent(), 0, 'pushed at once when it arrived: not again')
  setNotifyPrefs(ctx.db, ctx.alice.id, { mode: 'coordinator' })
  assert.equal(ctx.pipeline.resumeHeldConsent(Date.now() + 5 * 60 * 1000), 0, 'its hold long over: it already pushed before the restart')
  assert.equal(ctx.pipeline.resumeHeldConsent(), 1)
})

test('resumeHeldConsent: the startup read uses the partial index, not a full events scan', async () => {
  const db = openDb(':memory:')
  const plan = db.prepare("EXPLAIN QUERY PLAN SELECT user_id, seq FROM events WHERE type='permission_request' AND ts > ?").all(0).map((r) => r.detail).join(' ')
  assert.match(plan, /idx_events_permission_request/)
})

test('badge: Coordinator mode counts the Coordinator\'s unread plus items awaiting the user', async (t) => {
  const ctx = await setup(t)
  append(ctx.db, { userId: ctx.alice.id, convoId: 'work', sender: 'agent:box', type: 'text', payload: { body: 'unread elsewhere' } })
  createItem(ctx.db, { userId: ctx.alice.id, kind: 'question', title: 'q', awaiting: 'user', originConvoId: 'work', originDeviceId: ctx.workBox, createdBy: 'agent' })
  ctx.emit('coord', 'prompt', { question: 'go?' })
  await tick()
  // 'coord' unread: its prompt, plus the 1 item.
  const coordUnread = ctx.db.prepare("SELECT unread_count FROM conversations WHERE id='coord'").get().unread_count
  assert.equal(ctx.stub.calls[0].payload.aps.badge, coordUnread + 1)
  setNotifyPrefs(ctx.db, ctx.alice.id, { mode: 'all' })
  ctx.finish('coord')
  await tick()
  const total = ctx.db.prepare('SELECT SUM(unread_count) AS n FROM conversations').get().n
  assert.equal(ctx.stub.calls[1].payload.aps.badge, total)
})

test('notifyView: the settings screen\'s whole view', async (t) => {
  const ctx = await setup(t)
  setConvoNotify(ctx.db, ctx.alice.id, 'work', { mute_until: Date.now() + 1000 })
  setConvoNotify(ctx.db, ctx.alice.id, 'coord', { mute_until: Date.now() - 1000 })
  const v = notifyView(ctx.db, ctx.alice.id, ctx.phone)
  assert.equal(v.mode, 'coordinator')
  assert.equal(v.has_coordinator, true)
  assert.equal(v.device_level, 'all')
  assert.deepEqual(v.convos.map((c) => c.convo_id), ['work'], 'an expired mute with no level is not listed')
  setConvoNotify(ctx.db, ctx.alice.id, 'work', { mute_until: null })
  assert.equal(ctx.db.prepare('SELECT COUNT(*) AS n FROM convo_notify').get().n, 1, 'clearing the last override deletes the row ... ')
})

test('HTTP: GET/PUT /notify, validation, ownership, agents forbidden, live frame to the other app', async (t) => {
  const s = await startTestServer({})
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const ag = createAgent(s.db, alice.id, 'box')
  const phone = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'phone' } })).json.token
  const mac = (await s.http('/login', { method: 'POST', body: { username: 'alice', password: 'pw', device_name: 'mac' } })).json.token
  upsertConversation(s.db, { id: 'mine', ownerUserId: alice.id, title: 'mine' })

  const g = await s.http('/notify', { token: phone })
  assert.equal(g.status, 200)
  assert.equal(g.json.mode, 'coordinator')
  assert.equal((await s.http('/notify', { token: ag.token })).status, 403)

  for (const body of [{}, { mode: 'loud' }, { events: { nope: true } }, { events: { rooms: 1 } }, { device_level: 'some' },
    { convo: { convo_id: 'mine' } }, { convo: { convo_id: 'mine', level: 'loud' } },
    { convo: { convo_id: 'mine', mute_until: Date.now() + 30 * 24 * 3600 * 1000 } }, { extra: 1 }]) {
    assert.equal((await s.http('/notify', { method: 'PUT', token: phone, body })).status, 400, JSON.stringify(body))
  }
  assert.equal((await s.http('/notify', { method: 'PUT', token: phone, body: { convo: { convo_id: 'not-mine', level: 'none' } } })).status, 404)

  const macWs = await makeWsClient(s.base, { token: mac, cursor: null })
  await macWs.waitFor((f) => f.op === 'hello_ok')
  const until = Date.now() + 3600000
  const put = await s.http('/notify', { method: 'PUT', token: phone, body: { mode: 'all', device_level: 'needs_me', convo: { convo_id: 'mine', mute_until: until } } })
  assert.equal(put.status, 200)
  assert.equal(put.json.mode, 'all')
  assert.equal(put.json.device_level, 'needs_me')
  assert.deepEqual(put.json.convos, [{ convo_id: 'mine', level: null, mute_until: until }])
  const frame = await macWs.waitFor((f) => f.kind === 'notify')
  assert.equal(frame.settings.mode, 'all')
  assert.equal('device_level' in frame.settings, false, 'the device level is not synced')
  assert.equal((await s.http('/notify', { token: mac })).json.device_level, 'all', 'the phone\'s level is its own')
  macWs.close?.()
})
