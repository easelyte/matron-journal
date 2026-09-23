import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { getSpawn, createSpawnRequest, claimApprove, approveSpawn, discardSpawnRequest } from '../src/spawns.js'
import { participantIds } from '../src/participants.js'

// Fleet: one user, a parent agent (dev-6), a target agent (eric), a client.
// Parent owns 'parent-convo' — the conversation the consent card lands in.
async function spawnFleet(t, { connectTarget = true, serverOpts = {} } = {}) {
  const s = await startTestServer(serverOpts)
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const parentDev = createAgent(s.db, dan.id, 'dev-6')
  const targetDev = createAgent(s.db, dan.id, 'eric')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const parent = await makeWsClient(s.base, { token: parentDev.token, cursor: null })
  const target = connectTarget ? await makeWsClient(s.base, { token: targetDev.token, cursor: null }) : null
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  await parent.waitFor((f) => f.op === 'hello_ok')
  if (target) await target.waitFor((f) => f.op === 'hello_ok')
  await client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { parent.close(); target?.close(); client.close() })
  parent.send({ op: 'convo_upsert', convo_id: 'parent-convo', title: 'parent session', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'session_status')
  parent.frames.length = 0
  if (target) target.frames.length = 0
  client.frames.length = 0
  const clientDev = { deviceId: login.json.device_id }
  return { s, dan, parentDev, targetDev, clientToken, clientDev, parent, target, client }
}

test('a bridge reply to a journal-originated request settles the broker, not the client relay', async (t) => {
  const { s, dan, targetDev, target } = await spawnFleet(t)
  const p = s.broker.issue(s.hub, dan.id, targetDev.deviceId, 'start', { workdir: '/w', prompt: 'go', room_id: 'r' }, { timeoutMs: 5000 })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  assert.equal(req.request.from_device_id, 0)
  target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: req.request.from_device_id, ok: true, result: { convo_id: 'child-1' } })
  assert.deepEqual(await p, { ok: true, result: { convo_id: 'child-1' } })
})

test('a spoofed reply from a different agent device falls through to not_found', async (t) => {
  const { s, dan, parentDev, targetDev, parent, target } = await spawnFleet(t)
  const p = s.broker.issue(s.hub, dan.id, targetDev.deviceId, 'start', {}, { timeoutMs: 1000 })
  const req = await target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start')
  // parent (wrong device) tries to answer the target's request
  parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'evil' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'not_found') // device 0 is no client device — anti-enumeration shape
  const r = await p // then times out (1s) — the spoof never settled it
  assert.deepEqual(r, { ok: false, error: { code: 'timeout' } })
})

const isSpawnCard = (f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_spawn'

// Shared predicate for the new durable event.
const isOutcomeEvent = (f, spawnId) => f.kind === 'journal' && f.type === 'spawn_outcome'
  && f.payload?.request_id === spawnId

test('spawn_request parks a row, publishes a client-only card into the parent convo, acks pending', async (t) => {
  const { s, parentDev, targetDev, parent, target, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/home/dan/proj',
    task: 'fix the flaky test\nand report back', topic: 'flaky test',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(ack.request_id, 'q1')
  assert.ok(ack.spawn_id)
  const row = getSpawn(s.db, ack.spawn_id)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.from_device_id, parentDev.deviceId)
  assert.equal(row.workdir, '/home/dan/proj')
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.convo_id, 'parent-convo')
  assert.equal(card.payload.request_id, ack.spawn_id)
  assert.equal(card.payload.from_name, 'dev-6')
  assert.equal(card.payload.target_name, 'eric')
  assert.equal(card.payload.workdir, '/home/dan/proj')
  assert.ok(!card.payload.task.includes('\n')) // peer-text discipline: no forged card lines
  // client-only: neither agent may ever see the card
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(parent.frames.find(isSpawnCard), undefined)
  assert.equal(target.frames.find(isSpawnCard), undefined)
})

test('spawn_request against an offline box with no wake command is refused before any card exists', async (t) => {
  const { s, targetDev, parent, client } = await spawnFleet(t, { connectTarget: false })
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'x',
  })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'agent_unreachable')
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM agent_spawn_requests').get().c, 0)
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(client.frames.find(isSpawnCard), undefined)
})

test('spawn_request authorization: clients are forbidden; unknown/foreign/client targets are not_found; foreign from_convo_id is not_found', async (t) => {
  const { s, dan, targetDev, clientDev, parent, client } = await spawnFleet(t)
  // client kind cannot issue the op
  client.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const e1 = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e1.code, 'forbidden')
  // unknown target device
  parent.send({ op: 'spawn_request', request_id: 'q2', from_convo_id: 'parent-convo', target_device_id: 9999, workdir: '/w', task: 'x' })
  const e2 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e2.code, 'not_found')
  // a convo the parent does not own cannot front the ask
  parent.frames.length = 0
  parent.send({ op: 'spawn_request', request_id: 'q3', from_convo_id: 'someone-elses', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const e3 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e3.code, 'not_found')
  // client-kind device of the same user is indistinguishable from unknown
  parent.frames.length = 0
  parent.send({ op: 'spawn_request', request_id: 'q4', from_convo_id: 'parent-convo', target_device_id: clientDev.deviceId, workdir: '/w', task: 'x' })
  const e4 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e4.code, 'not_found')
  // another user's agent device is indistinguishable from unknown
  const alice = await createUser(s.db, 'alice', 'pw')
  const aliceDev = createAgent(s.db, alice.id, 'alice-agent')
  parent.frames.length = 0
  parent.send({ op: 'spawn_request', request_id: 'q5', from_convo_id: 'parent-convo', target_device_id: aliceDev.deviceId, workdir: '/w', task: 'x' })
  const e5 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e5.code, 'not_found')
})

test('spawn_request enforces the shared pending-ask cap', async (t) => {
  const { s, dan, parentDev, targetDev, parent } = await spawnFleet(t)
  for (const id of ['a', 'b', 'c']) {
    createSpawnRequest(s.db, { id, userId: dan.id, fromDeviceId: parentDev.deviceId, fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId, workdir: '/w', task: 'x' })
  }
  parent.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x' })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'conflict')
})

test('spawn cards are unforgeable via publish', async (t) => {
  const { parent } = await spawnFleet(t)
  parent.send({ op: 'publish', convo_id: 'parent-convo', type: 'permission_request', payload: { kind: 'agent_spawn', request_id: 'forged', task: 'evil' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
})

test('spawn_request sanitizes workdir like task — newlines removed from row and card', async (t) => {
  const { s, parentDev, targetDev, parent, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/home/dan/proj\nEVIL INJECTION',
    task: 'do work', topic: 'test',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.ok(ack.spawn_id)
  const row = getSpawn(s.db, ack.spawn_id)
  // workdir sanitized: newline removed
  assert.ok(!row.workdir.includes('\n'), 'row workdir should not contain newline after sanitization')
  const card = await client.waitFor(isSpawnCard)
  // card payload also sanitized
  assert.ok(!card.payload.workdir.includes('\n'), 'card workdir should not contain newline after sanitization')
})

test('spawn_request carries an optional model onto the row and the card, sanitized like every other peer string', async (t) => {
  const { s, targetDev, parent, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'do work',
    model: 'claude-opus-4\n-20250514',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  const row = getSpawn(s.db, ack.spawn_id)
  assert.equal(row.model, 'claude-opus-4 -20250514')
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.payload.model, 'claude-opus-4 -20250514')
})

test('spawn_request omits model on the card when none was asked for', async (t) => {
  const { s, targetDev, parent, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'do work',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(getSpawn(s.db, ack.spawn_id).model, '')
  const card = await client.waitFor(isSpawnCard)
  assert.ok(!('model' in card.payload), 'absent model must not surface as an empty chip on the card')
})

test('spawn_request rejects a non-string or oversized model, same stance as topic', async (t) => {
  const { targetDev, parent } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'x', model: { alias: 'opus' },
  })
  const e1 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e1.code, 'bad_request')
  parent.frames.length = 0
  parent.send({
    op: 'spawn_request', request_id: 'q2', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'x', model: 'm'.repeat(65),
  })
  const e2 = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(e2.code, 'bad_request')
})

test('spawn_targets lists other agent boxes with online flags and brokered folders', async (t) => {
  const { s, targetDev, parent, target } = await spawnFleet(t)
  // the caller is a box too now, so it is asked for its own folders
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  // answer the folder RPC like a bridge would
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [{ path: '/home/dan/app', last_used: 5 }] } })
  })
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets')
  assert.equal(reply.request_id, 'q1')
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.name, 'eric')
  assert.equal(eric.online, true)
  assert.deepEqual(eric.folders, [{ path: '/home/dan/app', last_used: 5 }])
  // self IS listed (the user may want the session on this very machine),
  // flagged so a caller can tell it apart, and not flagged on anyone else
  const me = reply.boxes.find((b) => b.self === true)
  assert.equal(me.name, 'dev-6 (this box)') // easelyte fork: self tagged (loop #690)
  assert.equal(me.self, true)
  assert.equal(me.online, true)
  assert.equal('self' in eric, false)
})

test('spawn_targets: the caller answers its own recent_folders rpc, so the self entry carries folders too', async (t) => {
  const { parentDev, parent } = await spawnFleet(t, { connectTarget: false })
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [{ path: '/Users/dan/Dev', last_used: 7 }] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q-self' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets')
  const me = reply.boxes.find((b) => b.device_id === parentDev.deviceId)
  assert.equal(me.self, true)
  assert.deepEqual(me.folders, [{ path: '/Users/dan/Dev', last_used: 7 }])
})

test('spawn on self: the card names the same box both ways, approve sends the start rpc to the caller, the room has the caller as owner and only participant', async (t) => {
  const { s, parentDev, clientToken, parent, client } = await spawnFleet(t, { connectTarget: false })
  parent.send({ op: 'spawn_request', request_id: 'rs', from_convo_id: 'parent-convo', target_device_id: parentDev.deviceId, workdir: '/w', task: 'carry on here', link: true })
  const card = await client.waitFor((f) => f.kind === 'journal' && f.type === 'permission_request' && f.payload?.kind === 'agent_spawn')
  assert.equal(card.payload.from_device_id, parentDev.deviceId)
  assert.equal(card.payload.target_device_id, parentDev.deviceId)
  assert.equal(card.payload.target_name, 'dev-6')
  const spawnId = card.payload.request_id
  const bridgeTurn = parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    assert.equal(req.request.params.prompt, 'carry on here')
    assert.equal(req.request.params.from_name, 'dev-6')
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-on-self' } })
    return req.request.params.room_id
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const roomId = await bridgeTurn
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started')
  assert.equal(out.child_convo_id, 'child-on-self')
  const room = s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(roomId)
  assert.equal(room.agent_device_id, parentDev.deviceId)
  const joined = s.db.prepare('SELECT agent_device_id, state FROM convo_agents WHERE convo_id=?').all(roomId)
  assert.deepEqual(joined, [{ agent_device_id: parentDev.deviceId, state: 'joined' }])
})

test('spawn_targets: valid capacity blocks pass through; a malformed block is dropped but the box stays', async (t) => {
  const { s, dan, targetDev, parent, target } = await spawnFleet(t)
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  const second = createAgent(s.db, dan.id, 'sicky')
  const bad = await makeWsClient(s.base, { token: second.token, cursor: null })
  await bad.waitFor((f) => f.op === 'hello_ok')
  t.after(() => bad.close())
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    target.send({
      op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true,
      result: {
        folders: [{ path: '/home/dan/app', last_used: 5 }],
        activity: { live_sessions: 1, last_hour: [{ path: '/w', sessions: 2 }] },
        limits: { as_of: 5, lines: [{ id: 'session', label: 'Session', percent: 10 }] },
        disk: { free_bytes: 1024, total_bytes: 4096 },
      },
    })
  })
  bad.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    bad.send({
      op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true,
      result: { folders: [], activity: { live_sessions: -5, last_hour: [] }, disk: { free_bytes: 9, total_bytes: 4 } },
    })
  })
  // self (the caller) is online too and now listed — answer its folder RPC so
  // the fan-out doesn't wait out the full folders timeout (loop #690)
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets')
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.deepEqual(eric.activity, { live_sessions: 1, last_hour: [{ path: '/w', sessions: 2 }] })
  assert.deepEqual(eric.limits, { as_of: 5, lines: [{ id: 'session', label: 'Session', percent: 10 }] })
  assert.deepEqual(eric.disk, { free_bytes: 1024, total_bytes: 4096 })
  const sicky = reply.boxes.find((b) => b.device_id === second.deviceId)
  assert.deepEqual(sicky.folders, [])
  assert.ok(!('activity' in sicky)) // malformed block dropped whole, box still listed
  assert.ok(!('limits' in sicky)) // no limits reported at all — omitted, not null
  assert.ok(!('disk' in sicky)) // free > total is nonsense — dropped whole, box still listed
})

test('spawn_targets: offline box listed with no folders; folder timeout degrades to empty', async (t) => {
  const { s, dan, targetDev, parent } = await spawnFleet(t, { connectTarget: false, serverOpts: { spawnFoldersTimeoutMs: 50 } })
  const silent = createAgent(s.db, dan.id, 'mute-box')
  const mute = await makeWsClient(s.base, { token: silent.token, cursor: null })
  await mute.waitFor((f) => f.op === 'hello_ok')
  t.after(() => mute.close())
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.equal(eric.online, false)      // offline: no RPC even attempted
  assert.deepEqual(eric.folders, [])
  const muteBox = reply.boxes.find((b) => b.name === 'mute-box')
  assert.equal(muteBox.online, true)    // online but never answered: timeout → []
  assert.deepEqual(muteBox.folders, [])
})

test('spawn_targets is agent-only and hides private boxes from ordinary agents', async (t) => {
  const { s, dan, parent, client } = await spawnFleet(t)
  client.send({ op: 'spawn_targets', request_id: 'q1' })
  const err = await client.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'forbidden')
  const priv = createAgent(s.db, dan.id, 'secret-box')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  parent.frames.length = 0
  // self (ordinary caller) is online and now listed — answer its folder RPC
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q2' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  assert.equal(reply.boxes.some((b) => b.name === 'secret-box'), false)
})

async function parkedSpawn(t, opts = {}) {
  const fleet = await spawnFleet(t, opts)
  const { targetDev, parent, client } = fleet
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId, workdir: '/w', task: 'do it', topic: 'job',
    // Linked by default here: most of the suite is about the room. The
    // detached (default-on-the-wire) shape has its own tests below.
    link: opts.link ?? true,
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  parent.frames.length = 0
  client.frames.length = 0
  return { ...fleet, spawnId: ack.spawn_id }
}

test('deny resolves the row and tells the parent plainly: declined', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  assert.equal(getSpawn(s.db, spawnId).state, 'denied')
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.request_id, spawnId)
  assert.equal(out.outcome, 'declined') // spec: no peer to hide behind — a plain no
  // second answer of any kind conflicts
  const again = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(again.status, 409)
})

test('answer endpoint gates: agent tokens 403 (even the parent), unknown id 404, always_allow 400', async (t) => {
  const { s, parentDev, clientToken, spawnId } = await parkedSpawn(t)
  const asAgent = await s.http('/agent-spawn/answer', { method: 'POST', token: parentDev.token, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(asAgent.status, 403)
  const unknown = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: 'no-such-row', decision: 'deny' } })
  assert.equal(unknown.status, 404)
  const standing = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve', always_allow: true } })
  assert.equal(standing.status, 400)
  assert.equal(getSpawn(s.db, spawnId).state, 'awaiting_user') // untouched by the three rejections
})

test("another user's client cannot see or answer the row (404, anti-enumeration)", async (t) => {
  const { s, spawnId } = await parkedSpawn(t)
  const eve = await createUser(s.db, 'eve', 'pw2')
  const evilLogin = await s.http('/login', { method: 'POST', body: { username: 'eve', password: 'pw2', device_name: 'phone' } })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: evilLogin.json.token, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 404)
  assert.equal(getSpawn(s.db, spawnId).state, 'awaiting_user')
})

test('approve: room exists BEFORE start rpc; started outcome carries room and child ids', async (t) => {
  const { s, dan, parentDev, targetDev, clientToken, parent, target, client, spawnId } = await parkedSpawn(t)
  // Bridge side of the start rpc: assert the room already exists when the
  // rpc arrives (ordering is load-bearing), then answer like journal-rpc.js
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    assert.equal(req.request.params.prompt, 'do it')
    assert.equal(req.request.params.workdir, '/w')
    assert.equal(req.request.params.from_name, 'dev-6') // parent device name, for the child's opening turn
    const room = s.db.prepare('SELECT * FROM conversations WHERE id=?').get(req.request.params.room_id)
    assert.ok(room, 'room row must exist before the bridge is asked to spawn')
    assert.equal(room.agent_device_id, parentDev.deviceId) // parent owns the room
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-convo-1' } })
    return req.request.params.room_id
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const roomId = await bridgeTurn
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started')
  assert.equal(out.room_id, roomId)
  assert.equal(out.child_convo_id, 'child-convo-1')
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'started')
  assert.equal(row.room_id, roomId)
  assert.equal(row.child_convo_id, 'child-convo-1')
  // both ends of the pair are in: parent as recorded owner, target joined
  const joined = s.db.prepare('SELECT agent_device_id, state FROM convo_agents WHERE convo_id=?').all(roomId)
  assert.deepEqual(joined, [{ agent_device_id: targetDev.deviceId, state: 'joined' }])
})

test('approve with the target gone by approval time: failed outcome, room gets the epitaph', async (t) => {
  const { s, clientToken, parent, target, spawnId } = await parkedSpawn(t, { serverOpts: { spawnStartTimeoutMs: 30000 } })
  target.close() // box dies between the card and the tap
  await new Promise((r) => setTimeout(r, 50))
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'agent_unreachable')
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'failed')
  // The room linkage is persisted BEFORE the start rpc, so even a FAILED
  // row points at the room that carries its epitaph.
  assert.ok(row.room_id)
  const epitaph = s.db.prepare("SELECT payload FROM events WHERE convo_id=? AND type='text' AND sender='journal'").all(row.room_id)
    .map((e) => JSON.parse(e.payload))
  assert.ok(epitaph.some((p) => p.body.includes('spawn failed')))
})

test('start timeout resolves failed — never left hanging', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t, { serverOpts: { spawnStartTimeoutMs: 100 } })
  // target stays connected but never answers the start rpc
  await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'timeout')
  assert.equal(getSpawn(s.db, spawnId).state, 'failed')
})

test('two approve taps spawn once: the loser gets 409 and no second room appears', async (t) => {
  const { s, clientToken, target, spawnId } = await parkedSpawn(t)
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-1' } })
  })
  const [a, b] = await Promise.all([
    s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } }),
    s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } }),
  ])
  assert.deepEqual([a.status, b.status].sort(), [200, 409])
  // exactly one room: the parked row's convo plus ONE new conversation
  await new Promise((r) => setTimeout(r, 200))
  const convos = s.db.prepare("SELECT COUNT(*) c FROM conversations WHERE id != 'parent-convo'").get().c
  assert.equal(convos, 1)
})

test('approve claims the row atomically; second approve conflicts', async (t) => {
  // spawnStartTimeoutMs kept short: this test only asserts on the claim
  // (the row's 'approved' state and the second tap's 409), not on the
  // orchestration outcome — nothing here answers the 'start' rpc, so the
  // background approveSpawn() the route fires would otherwise sit on the
  // default 30s timeout well past this test's own teardown.
  const { s, dan, parentDev, targetDev, clientToken, parent } = await spawnFleet(t, { serverOpts: { spawnStartTimeoutMs: 100 } })
  const spawnId = 'test-spawn-id'
  createSpawnRequest(s.db, {
    id: spawnId, userId: dan.id, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'test', topic: 'test',
  })
  // First approve claim succeeds
  const r1 = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r1.status, 200)
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'approved')
  assert.ok(row.answered_at) // timestamp set
  // Second approve attempt conflicts
  const r2 = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r2.status, 409)
  // Drain the background approveSpawn() the first tap fired before teardown
  // closes the DB out from under it (nothing here answers the 'start' rpc,
  // so it settles failed/timeout — same wait the adjacent "start timeout
  // resolves failed" test uses).
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
})

test('an unanswered spawn ask expires on the sweep and the parent hears expired', async (t) => {
  const { s, parent, spawnId } = await parkedSpawn(t, { serverOpts: { revocationSweepMs: 100 } })
  // Age the row past the 24h TTL by hand; the next sweep tick must flip it.
  s.db.prepare('UPDATE agent_spawn_requests SET created_at = created_at - (25*60*60*1000) WHERE id=?').run(spawnId)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.request_id, spawnId)
  assert.equal(out.outcome, 'expired')
  assert.equal(getSpawn(s.db, spawnId).state, 'expired')
})

test('a row stranded in approved (restart-before-settle gap) is recovered by the sweep: failed/orphaned, exactly once', async (t) => {
  const { s, dan, parentDev, targetDev, parent } = await spawnFleet(t, { serverOpts: { revocationSweepMs: 100 } })
  const spawnId = 'orphan-1'
  createSpawnRequest(s.db, {
    id: spawnId, userId: dan.id, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'do it', topic: 'job',
  })
  // Simulate claimApprove having won, then the in-memory broker never
  // settling it (e.g. a restart in that gap) — the row sits in 'approved'
  // with no live orchestration left to resolve it.
  assert.ok(claimApprove(s.db, spawnId))
  // Backdate answered_at past the 5-minute orphan TTL by hand; the next
  // sweep tick must flip it.
  s.db.prepare('UPDATE agent_spawn_requests SET answered_at = answered_at - (6*60*1000) WHERE id=?').run(spawnId)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.request_id, spawnId)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'orphaned')
  assert.equal(getSpawn(s.db, spawnId).state, 'failed')
  // Exactly one outcome frame — let a couple more sweep ticks pass and
  // confirm no duplicate arrives (the state-scoped UPDATE must make the
  // second tick's WHERE clause match zero rows).
  await new Promise((r) => setTimeout(r, 300))
  const outcomes = parent.frames.filter((f) => f.kind === 'spawn' && f.event === 'outcome' && f.request_id === spawnId)
  assert.equal(outcomes.length, 1)
})

test('approveSpawn: a throw before the room exists still notifies the parent exactly once (epitaph write is best-effort)', async (t) => {
  const { s, parentDev, targetDev } = await spawnFleet(t)
  // No users row for this id — upsertConversation's INSERT into
  // conversations (owner_user_id REFERENCES users(id), foreign_keys=ON)
  // throws before the room is ever created, exercising the "throw before
  // broker.issue" path from inside the try block itself.
  const bogusUserId = 999999
  const spawnId = 'no-room-1'
  createSpawnRequest(s.db, {
    id: spawnId, userId: bogusUserId, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'x', link: true,
  })
  assert.ok(claimApprove(s.db, spawnId))
  const sent = []
  const originalSendToDevice = s.hub.sendToDevice.bind(s.hub)
  s.hub.sendToDevice = (userId, deviceId, frame) => {
    sent.push({ userId, deviceId, frame })
    return originalSendToDevice(userId, deviceId, frame)
  }
  t.after(() => { s.hub.sendToDevice = originalSendToDevice })
  const outcome = await approveSpawn({ db: s.db, hub: s.hub, broker: s.broker, startTimeoutMs: 1000 }, getSpawn(s.db, spawnId))
  assert.equal(outcome, 'failed')
  assert.equal(getSpawn(s.db, spawnId).state, 'failed')
  // The epitaph write (into a room that never got created) failed silently;
  // the outcome frame must still have gone out, exactly once.
  const outcomeSends = sent.filter((c) => c.frame.kind === 'spawn' && c.frame.event === 'outcome')
  assert.equal(outcomeSends.length, 1)
  assert.equal(outcomeSends[0].frame.outcome, 'failed')
  assert.equal(outcomeSends[0].frame.error_code, 'internal')
})

test("a bridge's failed start reply: the peer-authored error code is sanitized before the outcome frame", async (t) => {
  const { s, clientToken, parent, target, spawnId } = await parkedSpawn(t)
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    // A code with an embedded newline passes agent_response's own gate
    // (string, 1..64 chars) — the outcome frame must still be line-safe.
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: false, error: { code: 'boom\ncode' } })
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'boom code') // sanitizePeerText: control chars flattened
  assert.ok(!out.error_code.includes('\n'))
})

test('orphan sweep TTL scales with spawnStartTimeoutMs — a long start timeout is never undercut', async (t) => {
  // 10-minute start timeout -> effective orphan TTL is 20 minutes, not the
  // 5-minute floor. A row 6 minutes into its claim must be left alone.
  const { s, dan, parentDev, targetDev, parent } = await spawnFleet(t, {
    serverOpts: { revocationSweepMs: 100, spawnStartTimeoutMs: 10 * 60 * 1000 },
  })
  const spawnId = 'slow-start-1'
  createSpawnRequest(s.db, {
    id: spawnId, userId: dan.id, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'slow', topic: '',
  })
  assert.ok(claimApprove(s.db, spawnId))
  s.db.prepare('UPDATE agent_spawn_requests SET answered_at = answered_at - (6*60*1000) WHERE id=?').run(spawnId)
  await new Promise((r) => setTimeout(r, 400))
  assert.equal(getSpawn(s.db, spawnId).state, 'approved') // sweep must NOT have flipped it
  assert.equal(parent.frames.filter((f) => f.kind === 'spawn' && f.event === 'outcome').length, 0)
  // Past the derived TTL (20 min) the sweep takes it, as ever.
  s.db.prepare('UPDATE agent_spawn_requests SET answered_at = answered_at - (15*60*1000) WHERE id=?').run(spawnId)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'orphaned')
})

test('restart after the room exists: the sweep finds the persisted linkage and writes the epitaph into the room', async (t) => {
  const { s, dan, parentDev, targetDev, parent } = await spawnFleet(t, { serverOpts: { revocationSweepMs: 100 } })
  const spawnId = 'orphan-with-room-1'
  const roomId = 'orphan-room-x'
  createSpawnRequest(s.db, {
    id: spawnId, userId: dan.id, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'do it', topic: 'job', link: true,
  })
  assert.ok(claimApprove(s.db, spawnId))
  // An orchestration that dies mid-flight: room created, start rpc issued,
  // never settles (a never-resolving broker stands in for the process
  // restart that strands the row).
  approveSpawn(
    { db: s.db, hub: s.hub, broker: { issue: () => new Promise(() => {}) }, startTimeoutMs: 30000, roomId },
    getSpawn(s.db, spawnId),
  )
  await new Promise((r) => setTimeout(r, 100))
  // The linkage is on the row BEFORE the rpc could ever settle.
  assert.equal(getSpawn(s.db, spawnId).room_id, roomId)
  s.db.prepare('UPDATE agent_spawn_requests SET answered_at = answered_at - (6*60*1000) WHERE id=?').run(spawnId)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'orphaned')
  // The dead room is explained, not abandoned.
  const epitaph = s.db.prepare("SELECT payload FROM events WHERE convo_id=? AND type='text' AND sender='journal'").all(roomId)
    .map((e) => JSON.parse(e.payload))
  assert.ok(epitaph.some((p) => p.body.includes('orphaned')))
})

// Durable spawn_outcome events (spec: 2026-08-11 spawn outcome events) — a
// journal event alongside the ephemeral {kind:'spawn',event:'outcome'}
// frame every terminal transition already sends. Each case below re-drives
// one of the five call sites and asserts BOTH: the ephemeral frame still
// arrives at the parent agent (additive, not a replacement) AND the durable
// event lands in the parent convo — visible to the client (owns dan's
// conversations) and, since spawn_outcome is agent-visible, to the parent
// agent itself (it owns parent-convo).

test('started: the durable spawn_outcome event carries room+child ids and no error_code, and reaches both client and parent agent', async (t) => {
  const { s, clientToken, parent, target, client, spawnId } = await parkedSpawn(t)
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-convo-9' } })
    return req.request.params.room_id
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const roomId = await bridgeTurn
  // ephemeral frame is additive, still arrives
  const ephemeral = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(ephemeral.outcome, 'started')
  // durable event reaches the client
  const clientEvt = await client.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(clientEvt.convo_id, 'parent-convo')
  assert.equal(clientEvt.payload.outcome, 'started')
  assert.equal(clientEvt.payload.room_id, roomId)
  assert.equal(clientEvt.payload.child_convo_id, 'child-convo-9')
  assert.deepEqual(Object.keys(clientEvt.payload).sort(), ['child_convo_id', 'outcome', 'request_id', 'room_id'])
  // durable event ALSO reaches the parent agent live — it owns parent-convo,
  // and spawn_outcome is deliberately not client-only.
  const parentEvt = await parent.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(parentEvt.payload.outcome, 'started')
})

test('resolution updates the parent convo snippet and bumps unread — symmetry with the card (spawn_outcome is a MESSAGE_TYPE)', async (t) => {
  const { s, clientToken, spawnId } = await parkedSpawn(t)
  const afterCard = s.db.prepare("SELECT unread_count FROM conversations WHERE id='parent-convo'").get().unread_count
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  const convo = s.db.prepare("SELECT snippet, unread_count FROM conversations WHERE id='parent-convo'").get()
  assert.equal(convo.snippet, '🚫 Spawn declined')
  assert.equal(convo.unread_count, afterCard + 1)
})

test('declined: the durable spawn_outcome event carries only outcome+request_id', async (t) => {
  const { s, clientToken, parent, client, spawnId } = await parkedSpawn(t)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  const ephemeral = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(ephemeral.outcome, 'declined')
  const clientEvt = await client.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(clientEvt.convo_id, 'parent-convo')
  assert.equal(clientEvt.payload.outcome, 'declined')
  assert.deepEqual(Object.keys(clientEvt.payload).sort(), ['outcome', 'request_id'])
  const parentEvt = await parent.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(parentEvt.payload.outcome, 'declined')
  // Exactly-once guard: the durable append must never fire twice for one
  // resolution — the state-scoped UPDATE in denySpawn is what guarantees
  // this, but the guarantee is only worth as much as this assertion.
  const count = s.db.prepare(
    "SELECT COUNT(*) AS c FROM events WHERE type='spawn_outcome' AND json_extract(payload,'$.request_id')=?"
  ).get(spawnId).c
  assert.equal(count, 1)
})

test('failed: a bridge start-rpc error produces a durable spawn_outcome event with error_code', async (t) => {
  const { s, clientToken, parent, target, client, spawnId } = await parkedSpawn(t)
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: false, error: { code: 'bad_thing' } })
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const ephemeral = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(ephemeral.outcome, 'failed')
  const clientEvt = await client.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(clientEvt.convo_id, 'parent-convo')
  assert.equal(clientEvt.payload.outcome, 'failed')
  assert.equal(clientEvt.payload.error_code, 'bad_thing')
  assert.deepEqual(Object.keys(clientEvt.payload).sort(), ['error_code', 'outcome', 'request_id'])
  const parentEvt = await parent.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(parentEvt.payload.outcome, 'failed')
  await bridgeTurn
})

test('a start reply whose convo_id carries control characters is a bad reply, not a rewritten id', async (t) => {
  const { s, clientToken, parent, target, spawnId } = await parkedSpawn(t)
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child\n1' } })
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  assert.equal(out.error_code, 'bad_start_reply')
  // The forged id must not survive anywhere — not on the row, not in the
  // durable payload (which for a failure carries error_code only).
  assert.equal(getSpawn(s.db, spawnId).child_convo_id, null)
  const payload = s.db.prepare("SELECT payload FROM events WHERE type='spawn_outcome' AND json_extract(payload,'$.request_id')=?").get(spawnId)
  assert.deepEqual(Object.keys(JSON.parse(payload.payload)).sort(), ['error_code', 'outcome', 'request_id'])
  await bridgeTurn
})

test('expired: the sweep journals a durable spawn_outcome event with no extra keys', async (t) => {
  const { s, parent, client, spawnId } = await parkedSpawn(t, { serverOpts: { revocationSweepMs: 100 } })
  s.db.prepare('UPDATE agent_spawn_requests SET created_at = created_at - (25*60*60*1000) WHERE id=?').run(spawnId)
  const ephemeral = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(ephemeral.outcome, 'expired')
  const clientEvt = await client.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(clientEvt.convo_id, 'parent-convo')
  assert.equal(clientEvt.payload.outcome, 'expired')
  assert.deepEqual(Object.keys(clientEvt.payload).sort(), ['outcome', 'request_id'])
  const parentEvt = await parent.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(parentEvt.payload.outcome, 'expired')
})

test('orphaned: the stranded-approved sweep journals a durable spawn_outcome event with error_code orphaned', async (t) => {
  const { s, dan, parentDev, targetDev, parent, client } = await spawnFleet(t, { serverOpts: { revocationSweepMs: 100 } })
  const spawnId = 'orphan-durable-1'
  createSpawnRequest(s.db, {
    id: spawnId, userId: dan.id, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'do it', topic: 'job',
  })
  assert.ok(claimApprove(s.db, spawnId))
  s.db.prepare('UPDATE agent_spawn_requests SET answered_at = answered_at - (6*60*1000) WHERE id=?').run(spawnId)
  const ephemeral = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(ephemeral.outcome, 'failed')
  assert.equal(ephemeral.error_code, 'orphaned')
  const clientEvt = await client.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(clientEvt.convo_id, 'parent-convo')
  assert.equal(clientEvt.payload.outcome, 'failed')
  assert.equal(clientEvt.payload.error_code, 'orphaned')
  assert.deepEqual(Object.keys(clientEvt.payload).sort(), ['error_code', 'outcome', 'request_id'])
  const parentEvt = await parent.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.equal(parentEvt.payload.outcome, 'failed')
})

// --- Task 2 hardening: forgery, resilience, replay -------------------------

test('spawn_outcome is unforgeable via publish', async (t) => {
  const { s, parent, client } = await spawnFleet(t)
  parent.send({ op: 'publish', convo_id: 'parent-convo', type: 'spawn_outcome', payload: { request_id: 'forged', outcome: 'started' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='spawn_outcome'").get().n, 0,
    'the forged event must never be appended to the journal')
  assert.ok(!client.frames.some((f) => f.kind === 'journal' && f.type === 'spawn_outcome'), 'nothing reached the client either')
})

test('spawn_outcome is unforgeable via finalize', async (t) => {
  const { s, parent, client } = await spawnFleet(t)
  parent.send({ op: 'finalize', convo_id: 'parent-convo', message_ref: 'm1', type: 'spawn_outcome', payload: { request_id: 'forged', outcome: 'started' } })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'bad_request')
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='spawn_outcome'").get().n, 0,
    'the forged event must never be appended to the journal')
  assert.ok(!client.frames.some((f) => f.kind === 'journal' && f.type === 'spawn_outcome'), 'nothing reached the client either')
})

test('deny after the parent conversation row is gone: 200 still returns, the ephemeral frame still reaches the parent, no durable event exists, and the server keeps answering', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t)
  // from_convo_id may have been deleted since the ask was parked — the
  // append inside emitSpawnOutcome throws (append() requires an existing,
  // owned conversation); the design says that must be logged and swallowed,
  // never allowed to break the answer route or suppress the ephemeral frame.
  s.db.prepare("DELETE FROM conversations WHERE id='parent-convo'").run()
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'declined')
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='spawn_outcome'").get().n, 0,
    'the durable append failed silently — no row was left behind')
  // The server must still be alive and answering other requests — the
  // append failure must not have thrown out of the request handler.
  const alive = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'phone2' } })
  assert.equal(alive.status, 200)
})

test("agent replay: a fresh parent-agent connection's hello replay contains the resolved spawn's durable outcome event; the card itself stays absent", async (t) => {
  const { s, parentDev, clientToken, spawnId } = await parkedSpawn(t)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  const agentReplay = await makeWsClient(s.base, { token: parentDev.token, cursor: 0 })
  t.after(() => agentReplay.close())
  await agentReplay.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.ok(!agentReplay.journal().some(isSpawnCard), 'the client-only card must stay absent from the agent replay')
})

test("client replay: a fresh client connection's replay contains BOTH the card and the durable outcome event", async (t) => {
  const { s, clientToken, spawnId } = await parkedSpawn(t)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  const clientReplay = await makeWsClient(s.base, { token: clientToken, cursor: 0 })
  t.after(() => clientReplay.close())
  await clientReplay.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.ok(clientReplay.journal().some(isSpawnCard), 'the card must still be present in client replay')
  assert.ok(clientReplay.journal().some((f) => isOutcomeEvent(f, spawnId)), 'the durable outcome event must be present in client replay')
})

test('discardSpawnRequest removes only unanswered rows', async (t) => {
  const { s, dan, parentDev, targetDev } = await spawnFleet(t)
  const mk = (id) => createSpawnRequest(s.db, {
    id, userId: dan.id, fromDeviceId: parentDev.deviceId,
    fromConvoId: 'parent-convo', targetDeviceId: targetDev.deviceId,
    workdir: '/w', task: 'x', topic: '',
  })
  mk('discard-1')
  assert.equal(discardSpawnRequest(s.db, 'discard-1'), true)
  assert.equal(getSpawn(s.db, 'discard-1'), undefined)
  // An answered (claimed) row is out of discard's reach — state-scoped.
  mk('discard-2')
  assert.ok(claimApprove(s.db, 'discard-2'))
  assert.equal(discardSpawnRequest(s.db, 'discard-2'), false)
  assert.equal(getSpawn(s.db, 'discard-2').state, 'approved')
})

test('spawn_targets is single-flight per connection: a concurrent second ask is refused conflict', async (t) => {
  // Short folder timeout so the first fan-out (target never answers
  // recent_folders) resolves quickly after proving the overlap.
  const { parent } = await spawnFleet(t, { serverOpts: { spawnFoldersTimeoutMs: 500 } })
  parent.send({ op: 'spawn_targets', request_id: 'sf-1' })
  parent.send({ op: 'spawn_targets', request_id: 'sf-2' })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error', 5000)
  assert.equal(err.code, 'conflict')
  const first = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  assert.equal(first.request_id, 'sf-1')
  // The guard clears once the fan-out settles — a fresh ask goes through.
  parent.send({ op: 'spawn_targets', request_id: 'sf-3' })
  const third = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets' && f.request_id === 'sf-3', 5000)
  assert.ok(third)
})

// --- Loop #690: same-box spawn -------------------------------------------
// Fork divergence from upstream's deliberate self-spawn exclusion. A session
// may spawn ANOTHER session on its OWN box, seeded with a task — the
// copy-paste elimination the loop was filed for. Every same-box spawn STILL
// mints the journal-brokered consent card the operator taps (no silent spawn),
// and the child-convo guard STILL holds: a sub-chat / subagent-transcript
// convo (parent_convo_id set) can never originate a spawn. (That guard blocks
// child-convo spawns, NOT spawn DEPTH — a spawned session's own top-level
// convo is a root, so depth is bounded by the human consent gate, every hop
// needing an operator tap, not by an automatic counter.)

test('same-box spawn: spawn_request against the caller\'s OWN device is accepted and still parks a consent card', async (t) => {
  const { s, parentDev, parent, target, client } = await spawnFleet(t)
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: parentDev.deviceId, // SELF — same box
    workdir: '/home/dan/proj', task: 'spin up a sibling session', topic: 'same-box',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  assert.equal(ack.request_id, 'q1')
  assert.ok(ack.spawn_id)
  const row = getSpawn(s.db, ack.spawn_id)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.from_device_id, parentDev.deviceId)
  assert.equal(row.target_device_id, parentDev.deviceId) // both ends the same box
  // The consent card is STILL created — no silent same-box spawn. Client-only,
  // landed in the parent convo, naming the same box as both from and target.
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.convo_id, 'parent-convo')
  assert.equal(card.payload.request_id, ack.spawn_id)
  assert.equal(card.payload.from_device_id, parentDev.deviceId)
  assert.equal(card.payload.target_device_id, parentDev.deviceId)
  // client-only: neither agent socket may ever see the card
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(parent.frames.find(isSpawnCard), undefined)
  assert.equal(target.frames.find(isSpawnCard), undefined)
})

test('recursion guard intact: a spawned CHILD (parent_convo_id set) still cannot spawn, even on its own box', async (t) => {
  const { s, parentDev, parent } = await spawnFleet(t)
  // A child conversation, as a spawned session's transcript would be recorded.
  parent.send({ op: 'convo_upsert', convo_id: 'child-convo', title: 'child session', session_state: 'running', parent_convo_id: 'parent-convo' })
  await new Promise((r) => setTimeout(r, 50))
  // Attempt to spawn (same box) FROM the child convo — the recursion guard must
  // still reject it as an indistinguishable not_found: no card, no row.
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'child-convo',
    target_device_id: parentDev.deviceId, workdir: '/w', task: 'grandchild',
  })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error')
  assert.equal(err.code, 'not_found')
  assert.equal(s.db.prepare('SELECT COUNT(*) c FROM agent_spawn_requests').get().c, 0)
})

test('spawn_targets includes the caller\'s own box, tagged "(this box)" and flagged self', async (t) => {
  const { s, parentDev, targetDev, parent, target } = await spawnFleet(t)
  // Both the target AND self answer the folder RPC like a bridge would.
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [{ path: '/home/dan/app', last_used: 5 }] } })
  })
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [{ path: '/home/dan/self', last_used: 9 }] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets')
  const self = reply.boxes.find((b) => b.device_id === parentDev.deviceId)
  assert.ok(self, 'the caller\'s own box must now be listed')
  assert.equal(self.self, true)
  assert.match(self.name, /\(this box\)$/)
  assert.equal(self.online, true)
  assert.deepEqual(self.folders, [{ path: '/home/dan/self', last_used: 9 }]) // self's own recent folders
  // other boxes stay untagged
  const eric = reply.boxes.find((b) => b.device_id === targetDev.deviceId)
  assert.ok(!('self' in eric))
  assert.ok(!/\(this box\)/.test(eric.name))
})

test('spawn_targets still hides a private box from an ordinary agent even though self is now included', async (t) => {
  const { s, dan, parentDev, parent } = await spawnFleet(t, { connectTarget: false })
  const priv = createAgent(s.db, dan.id, 'secret-box')
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(priv.deviceId)
  parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'recent_folders').then((req) => {
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { folders: [] } })
  })
  parent.send({ op: 'spawn_targets', request_id: 'q1' })
  const reply = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'targets', 5000)
  assert.ok(reply.boxes.some((b) => b.device_id === parentDev.deviceId), 'self still listed')
  assert.equal(reply.boxes.some((b) => b.name === 'secret-box'), false, 'private box still hidden')
})

test('same-box approve produces a valid room: owner and sole participant are the same box, no broken room', async (t) => {
  const { s, parentDev, clientToken, parent, client } = await spawnFleet(t)
  // Park a same-box spawn (target == the parent's own device).
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: parentDev.deviceId, workdir: '/w', task: 'same-box job', topic: 'sb', link: true,
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  const spawnId = ack.spawn_id
  // The start rpc lands on the SAME box (the parent connection); the room must
  // already exist and be owned by that box when it arrives.
  const bridgeTurn = parent.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    const room = s.db.prepare('SELECT * FROM conversations WHERE id=?').get(req.request.params.room_id)
    assert.ok(room, 'room row must exist before the same-box start rpc')
    assert.equal(room.agent_device_id, parentDev.deviceId)
    parent.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-sb-1' } })
    return req.request.params.room_id
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  const roomId = await bridgeTurn
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started')
  assert.equal(out.room_id, roomId)
  assert.equal(out.child_convo_id, 'child-sb-1')
  // The degenerate room is valid: owner == the sole joined participant == same
  // box — one convo_agents row, and participantIds dedups to a single chip
  // rather than a broken two-of-the-same-box room.
  const room = s.db.prepare('SELECT agent_device_id FROM conversations WHERE id=?').get(roomId)
  assert.equal(room.agent_device_id, parentDev.deviceId)
  const joined = s.db.prepare("SELECT agent_device_id, state FROM convo_agents WHERE convo_id=?").all(roomId)
  assert.deepEqual(joined, [{ agent_device_id: parentDev.deviceId, state: 'joined' }])
  assert.deepEqual(participantIds(s.db, roomId), [parentDev.deviceId])
  const dbRow = getSpawn(s.db, spawnId)
  assert.equal(dbRow.state, 'started')
  assert.equal(dbRow.room_id, roomId)
})

// ---- link flag: the room is opt-in ---------------------------------------

test('spawn_request without link: the card carries no link key and approve spawns with no room at all', async (t) => {
  const { s, clientToken, parent, target, client, spawnId } = await parkedSpawn(t, { link: false })
  const parkedRow = getSpawn(s.db, spawnId)
  assert.equal(parkedRow.link, 0)
  // Replay the card to check its shape (parkedSpawn drained the live one).
  const card = JSON.parse(s.db.prepare("SELECT payload FROM events WHERE type='permission_request' AND convo_id='parent-convo'").get().payload)
  assert.ok(!('link' in card), 'a detached ask says nothing about a room')
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    assert.equal(req.request.params.prompt, 'do it')
    assert.equal(req.request.params.from_name, 'dev-6')
    assert.ok(!('room_id' in req.request.params), 'no room_id on a detached start')
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-detached' } })
  })
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })
  assert.equal(r.status, 200)
  await bridgeTurn
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started')
  assert.ok(!('room_id' in out))
  assert.equal(out.child_convo_id, 'child-detached')
  const evt = await client.waitFor((f) => isOutcomeEvent(f, spawnId))
  assert.deepEqual(Object.keys(evt.payload).sort(), ['child_convo_id', 'outcome', 'request_id'])
  const row = getSpawn(s.db, spawnId)
  assert.equal(row.state, 'started')
  assert.equal(row.room_id, null)
  // The only conversation is the parent's own — nothing was minted.
  assert.deepEqual(s.db.prepare('SELECT id FROM conversations ORDER BY id').all().map((c) => c.id), ['parent-convo'])
})

test('spawn_request with link: true carries link on the card; a non-boolean link is bad_request', async (t) => {
  const { s, targetDev, parent, client } = await spawnFleet(t)
  parent.send({ op: 'spawn_request', request_id: 'bad', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x', link: 'yes' })
  const err = await parent.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'spawn_request')
  assert.equal(err.code, 'bad_request')
  parent.send({ op: 'spawn_request', request_id: 'ok', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'x', link: true })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending' && f.request_id === 'ok')
  assert.equal(getSpawn(s.db, ack.spawn_id).link, 1)
  const card = await client.waitFor(isSpawnCard)
  assert.equal(card.payload.link, true)
})

test('a linked spawn room is titled like a bridge room and gains the child tag when the child publishes its title', async (t) => {
  const { s, dan, parentDev, targetDev, clientToken, parent, target, client } = await spawnFleet(t)
  // The parent's bridge baked a short into its title, as every bridge does.
  parent.send({ op: 'convo_upsert', convo_id: 'parent-convo', title: '[ab] parent session', session_state: 'running' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === 'parent-convo')
  parent.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'do it', topic: 'job', link: true })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  client.frames.length = 0
  const bridgeTurn = target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-t' } })
    return req.request.params.room_id
  })
  await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: ack.spawn_id, decision: 'approve' } })
  const roomId = await bridgeTurn
  await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  // At creation the child has no title yet, so its side is the device name.
  assert.equal(s.db.prepare('SELECT title FROM conversations WHERE id=?').get(roomId).title, 'D:ab ↔️ eric — job')
  const born = client.frames.find((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === roomId)
  assert.equal(born.payload.title, 'D:ab ↔️ eric — job')
  assert.deepEqual(born.payload.participants, [parentDev.deviceId, targetDev.deviceId].sort((a, b) => a - b))
  // The child's bridge publishes its seed title — the room retitles and
  // every live client hears it.
  client.frames.length = 0
  target.send({ op: 'convo_upsert', convo_id: 'child-t', title: '🐣 [cd] do it', session_state: 'running' })
  const retitled = await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === roomId && f.payload.title === 'D:ab ↔️ E:cd — job')
  assert.ok(retitled)
  assert.equal(s.db.prepare('SELECT title FROM conversations WHERE id=?').get(roomId).title, 'D:ab ↔️ E:cd — job')
  // A later child rename — even one carrying a different short — changes
  // nothing about the room: the first short is frozen on the row.
  client.frames.length = 0
  target.send({ op: 'convo_upsert', convo_id: 'child-t', title: '🐣 [zz] renamed', session_state: 'waiting' })
  await client.waitFor((f) => f.kind === 'journal' && f.type === 'convo_meta' && f.convo_id === 'child-t')
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(client.frames.find((f) => f.type === 'convo_meta' && f.convo_id === roomId), undefined)
  assert.equal(s.db.prepare('SELECT title FROM conversations WHERE id=?').get(roomId).title, 'D:ab ↔️ E:cd — job')
  assert.equal(getSpawn(s.db, ack.spawn_id).child_short, 'cd')
  assert.equal(dan.id > 0, true)
})

// --- Consent asks mirrored into the tracker (spec: 2026-09-22 consent-items) ---

const isItemMarker = (f) => f.kind === 'journal' && f.type === 'item'
const consentItemFor = (s, spawnId) => {
  const row = getSpawn(s.db, spawnId)
  assert.ok(row.item_id, 'the spawn row must point at its tracker item')
  return s.db.prepare('SELECT * FROM items WHERE id=?').get(row.item_id)
}
const closingStatus = (s, itemId) => s.db.prepare("SELECT * FROM item_comments WHERE item_id=? AND kind='status' ORDER BY rowid DESC LIMIT 1").get(itemId)

function makeStubApnsClient() {
  const calls = []
  return { calls, send(opts) { calls.push(opts); return Promise.resolve({ status: 200, reason: null }) } }
}

test('spawn_request also files a question item on the parent convo: awaiting the user, labelled consent, linked to the ask, top of the list', async (t) => {
  const stub = makeStubApnsClient()
  const { s, dan, parentDev, targetDev, parent, client, clientToken } = await spawnFleet(t, { serverOpts: { apnsClient: stub } })
  assert.equal((await s.http('/push/register', { method: 'POST', token: clientToken, body: { apns_token: 'phone-token', environment: 'prod' } })).status, 200)
  // An older open item, so "top of the list" is observable.
  const older = await s.http('/items', { method: 'POST', token: parentDev.token, body: { kind: 'task', title: 'older', convo_id: 'parent-convo' } })
  assert.equal(older.status, 201)
  client.frames.length = 0
  const before = s.db.prepare("SELECT unread_count, (SELECT COUNT(*) FROM events WHERE type='text' AND convo_id='parent-convo') AS texts FROM conversations WHERE id='parent-convo'").get()
  parent.send({
    op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo',
    target_device_id: targetDev.deviceId,
    workdir: '/home/dan/proj', task: 'fix the flaky test', topic: 'flaky test', model: 'opus',
  })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  const item = consentItemFor(s, ack.spawn_id)
  assert.equal(item.kind, 'question')
  assert.equal(item.state, 'open'); assert.equal(item.awaiting, 'user')
  assert.equal(item.origin_convo_id, 'parent-convo'); assert.equal(item.origin_device_id, parentDev.deviceId)
  assert.equal(item.created_by, 'agent')
  assert.equal(item.user_id, dan.id)
  assert.equal(item.title, 'Approve spawn on eric — flaky test')
  assert.deepEqual(JSON.parse(item.labels), ['consent'])
  assert.deepEqual(JSON.parse(item.links), [{ url: `matron://consent/spawn/${ack.spawn_id}`, title: `Spawn request ${ack.spawn_id}` }])
  assert.ok(item.body.includes('fix the flaky test') && item.body.includes('/home/dan/proj') && item.body.includes('opus'))
  assert.ok(item.rank < older.json.item.rank, 'a consent ask goes to the top, not the bottom')
  // A connected client learns of it live, the way it learns of any item.
  const marker = await client.waitFor((f) => isItemMarker(f) && f.payload.action === 'created' && f.payload.item_id === item.id)
  assert.equal(marker.convo_id, 'parent-convo')
  assert.equal(marker.sender, 'agent:dev-6')
  assert.equal(marker.payload.by, 'agent'); assert.equal(marker.payload.awaiting, 'user')
  assert.equal(marker.payload.consent, 'spawn')
  // Client-only, like the card it mirrors: the parent agent never hears of
  // the item, live or on replay.
  const isThisItem = (f) => isItemMarker(f) && f.payload.item_id === item.id
  await new Promise((r) => setTimeout(r, 100))
  assert.equal(parent.frames.some(isThisItem), false)
  // (The setup task's own marker above does reach the parent — an ordinary item.)
  assert.equal(parent.frames.some((f) => isItemMarker(f) && f.payload.item_id === older.json.item.id), true)
  const replay = await makeWsClient(s.base, { token: parentDev.token, cursor: 0 })
  await replay.waitFor((f) => f.op === 'hello_ok')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(replay.frames.some(isThisItem), false)
  assert.equal(replay.frames.some((f) => isItemMarker(f) && f.payload.item_id === older.json.item.id), true)
  replay.close()
  // The card is the conversation's message; the mirror adds no text of its
  // own (no old-client fallback), so the snippet and unread count are the
  // card's, not a second "needs you" line.
  const convo = s.db.prepare("SELECT snippet, unread_count FROM conversations WHERE id='parent-convo'").get()
  assert.equal(convo.snippet, '🤝 Agent spawn request')
  assert.equal(convo.unread_count, before.unread_count + 1)
  assert.equal(s.db.prepare("SELECT COUNT(*) n FROM events WHERE type='text' AND convo_id='parent-convo'").get().n, before.texts)
  // GET /items lists it for the client with the same fields.
  const listed = await s.http('/items?awaiting=user', { token: clientToken })
  assert.equal(listed.json.items[0].id, item.id)
  // The card already pushed; the mirror must not ring the pocket a second time.
  await new Promise((r) => setTimeout(r, 80))
  const alerts = stub.calls.filter((c) => c.deviceToken === 'phone-token' && c.payload.aps.alert)
  assert.equal(alerts.length, 1)
  assert.equal(alerts[0].payload.aps.alert.body, '🤝 Agent spawn request')
})

test('deny closes the consent item as decided, by the user, with a closing note — quietly for the parent agent', async (t) => {
  const { s, clientDev, clientToken, parent, client, spawnId } = await parkedSpawn(t)
  const item = consentItemFor(s, spawnId)
  const r = await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })
  assert.equal(r.status, 200)
  await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  const after = s.db.prepare('SELECT * FROM items WHERE id=?').get(item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'decided'); assert.equal(after.awaiting, null)
  const status = closingStatus(s, item.id)
  assert.equal(status.author, 'user'); assert.equal(status.device_id, clientDev.deviceId)
  assert.equal(status.body, 'Declined.')
  const marker = await client.waitFor((f) => isItemMarker(f) && f.payload.action === 'closed' && f.payload.item_id === item.id)
  assert.equal(marker.payload.by, 'user'); assert.equal(marker.payload.resolution, 'decided')
  // Written under the asking agent's device, never as a user:* event: a
  // user:* item marker is what a bridge turns into a session turn, and the
  // parent already hears the outcome as a spawn_outcome.
  assert.equal(marker.sender, 'agent:dev-6')
  assert.equal(marker.payload.consent, 'spawn')
  assert.equal(parent.frames.some(isItemMarker), false)
})

test('approve → started closes the consent item as decided, naming the box and the room', async (t) => {
  const { s, clientDev, clientToken, parent, target, spawnId } = await parkedSpawn(t)
  const item = consentItemFor(s, spawnId)
  target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start').then((req) => {
    target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-convo-1' } })
  })
  assert.equal((await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })).status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'started')
  const after = s.db.prepare('SELECT * FROM items WHERE id=?').get(item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'decided')
  const status = closingStatus(s, item.id)
  assert.equal(status.author, 'user'); assert.equal(status.device_id, clientDev.deviceId)
  assert.ok(status.body.includes('Approved') && status.body.includes('eric') && /chat room/i.test(status.body))
})

test('approve → failed closes the consent item as cancelled with the failure code', async (t) => {
  const { s, clientToken, parent, target, spawnId } = await parkedSpawn(t)
  const item = consentItemFor(s, spawnId)
  target.close()
  await new Promise((r) => setTimeout(r, 50))
  assert.equal((await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'approve' } })).status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'failed')
  const after = s.db.prepare('SELECT * FROM items WHERE id=?').get(item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'cancelled')
  const status = closingStatus(s, item.id)
  assert.equal(status.author, 'agent')
  assert.ok(status.body.includes('Approved, but') && status.body.includes(out.error_code))
})

test('an expired spawn ask closes its consent item as cancelled on the sweep', async (t) => {
  const { s, parent, spawnId } = await parkedSpawn(t, { serverOpts: { revocationSweepMs: 100 } })
  const item = consentItemFor(s, spawnId)
  s.db.prepare('UPDATE agent_spawn_requests SET created_at = created_at - (25*60*60*1000) WHERE id=?').run(spawnId)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome', 5000)
  assert.equal(out.outcome, 'expired')
  const after = s.db.prepare('SELECT * FROM items WHERE id=?').get(item.id)
  assert.equal(after.state, 'closed'); assert.equal(after.resolution, 'cancelled')
  assert.ok(closingStatus(s, item.id).body.includes('24 h'))
})

test('a consent item the user closed by hand is left alone by the outcome: the spawn still resolves', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t)
  const item = consentItemFor(s, spawnId)
  const closed = await s.http(`/items/${item.id}/close`, { method: 'POST', token: clientToken, body: { resolution: 'cancelled', comment: 'never mind' } })
  assert.equal(closed.status, 200)
  assert.equal((await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })).status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'declined')
  assert.equal(getSpawn(s.db, spawnId).state, 'denied')
  const after = s.db.prepare('SELECT * FROM items WHERE id=?').get(item.id)
  assert.equal(after.resolution, 'cancelled') // the user's own close stands
  assert.equal(closingStatus(s, item.id).body, 'never mind')
})

test('a spawn row with no consent item (filed before the mirror existed) resolves without one', async (t) => {
  const { s, clientToken, parent, spawnId } = await parkedSpawn(t)
  s.db.prepare('UPDATE agent_spawn_requests SET item_id=NULL WHERE id=?').run(spawnId)
  assert.equal((await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })).status, 200)
  const out = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal(out.outcome, 'declined')
})

test('a tracker failure never costs the ask: the card is published, pending is acked, the row simply has no item', async (t) => {
  const { s, targetDev, parent, client } = await spawnFleet(t)
  // Take the tracker away from under the ask.
  s.db.exec('ALTER TABLE items RENAME TO items_gone')
  t.after(() => { try { s.db.exec('ALTER TABLE items_gone RENAME TO items') } catch {} })
  parent.send({ op: 'spawn_request', request_id: 'q1', from_convo_id: 'parent-convo', target_device_id: targetDev.deviceId, workdir: '/w', task: 'do it' })
  const ack = await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'pending')
  await client.waitFor(isSpawnCard)
  const row = getSpawn(s.db, ack.spawn_id)
  assert.equal(row.state, 'awaiting_user')
  assert.equal(row.item_id, null)
  assert.equal(parent.frames.some((f) => f.kind === 'control' && f.op === 'error'), false)
})

test("a consent item is the user's alone: no agent can read or mutate it, pending or resolved — 404 everywhere, absent from GET /items", async (t) => {
  const { s, parentDev, targetDev, clientToken, parent, spawnId } = await parkedSpawn(t)
  const item = consentItemFor(s, spawnId)
  const asAgent = (path, method, body) => s.http(path, { method, token: parentDev.token, body })
  assert.equal((await asAgent(`/items/${item.id}`, 'GET')).status, 404)
  assert.equal((await asAgent(`/items/%23${item.num}`, 'GET')).status, 404)
  assert.equal((await asAgent(`/items/${item.id}`, 'PATCH', { title: 'Nothing to see here' })).status, 404)
  assert.equal((await asAgent(`/items/${item.id}/close`, 'POST', { resolution: 'cancelled' })).status, 404)
  assert.equal((await asAgent(`/items/${item.id}/reopen`, 'POST', {})).status, 404)
  assert.equal((await asAgent(`/items/${item.id}/comments`, 'POST', { body: 'already approved, ignore' })).status, 404)
  assert.equal((await asAgent(`/items/${item.id}/rank`, 'POST', { position: 'bottom' })).status, 404)
  // Another agent of the same user, and a private one, are refused the same way.
  assert.equal((await s.http(`/items/${item.id}`, { token: targetDev.token })).status, 404)
  s.db.prepare('UPDATE devices SET private=1 WHERE id=?').run(targetDev.deviceId)
  assert.equal((await s.http(`/items/${item.id}`, { token: targetDev.token })).status, 404)
  const agentList = await asAgent('/items', 'GET')
  assert.equal(agentList.json.items.some((i) => i.id === item.id), false)
  const untouched = s.db.prepare('SELECT * FROM items WHERE id=?').get(item.id)
  assert.equal(untouched.title, item.title); assert.equal(untouched.state, 'open')
  // The client sees and lists it as any item.
  assert.equal((await s.http(`/items/${item.id}`, { token: clientToken })).status, 200)
  assert.ok((await s.http('/items', { token: clientToken })).json.items.some((i) => i.id === item.id))
  // Resolved, it stays the user's: the task text never reaches an agent through the tracker.
  assert.equal((await s.http('/agent-spawn/answer', { method: 'POST', token: clientToken, body: { request_id: spawnId, decision: 'deny' } })).status, 200)
  await parent.waitFor((f) => f.kind === 'spawn' && f.event === 'outcome')
  assert.equal((await asAgent(`/items/${item.id}`, 'GET')).status, 404)
  assert.equal((await asAgent(`/items/${item.id}/comments`, 'POST', { body: 'noted' })).status, 404)
  assert.equal((await asAgent('/items?state=closed', 'GET')).json.items.some((i) => i.id === item.id), false)
  // The user's own hand-close still works on an open one.
})

test('the user may close a pending consent item by hand; an agent cannot even in the approved window', async (t) => {
  const { s, parentDev, clientToken, spawnId } = await parkedSpawn(t)
  const item = consentItemFor(s, spawnId)
  assert.ok(claimApprove(s.db, spawnId)) // the tap, with no orchestration running yet
  assert.equal(getSpawn(s.db, spawnId).state, 'approved')
  assert.equal((await s.http(`/items/${item.id}/close`, { method: 'POST', token: parentDev.token, body: { resolution: 'done' } })).status, 404)
  assert.equal(s.db.prepare('SELECT state FROM items WHERE id=?').get(item.id).state, 'open')
  assert.equal((await s.http(`/items/${item.id}/close`, { method: 'POST', token: clientToken, body: { resolution: 'cancelled' } })).status, 200)
})
