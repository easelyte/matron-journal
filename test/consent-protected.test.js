// Protected boxes and signed consent: a consent ask aimed at a box the user
// marked protected is the user's alone (it implies user-only), and once the
// account has an approval key its approval needs a `consent` statement over
// the subject the journal publishes, which the journal forwards unchanged to
// the box. A client's direct `start` on such a box is an account action. A
// decline never needs a signature; an account with no key behaves as with a
// user-only box.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { makeWsClient } from './helpers.js'
import { createAgent, createUser } from '../src/auth.js'
import { openDb, setDeviceProtected } from '../src/db.js'
import { upsertConversation } from '../src/journal.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { recordJoined, getParticipant } from '../src/participants.js'
import { getSpawn } from '../src/spawns.js'
import { getTransfer } from '../src/transfers.js'
import { consentSubject } from '../src/consent-subject.js'
import { needsUserTap } from '../src/item-handover.js'
import { runAdmin } from '../bin/matron-admin.js'
import { startWithKey, startApprovalServer, signAccount, signConsent, enableTwoFactor, enrolKeyByPassword, forgetApprovalFailures } from './approval-helpers.js'

const sha = (s) => crypto.createHash('sha256').update(s, 'utf8').digest('hex')
const TASK = 'fix the flaky test'
const WORKDIR = '/home/alice/proj'

// alice with (or without) an approval key on her phone; box-a asks, box-b is
// the target, coord-box runs the Coordinator. All three bridges connected.
async function world(t, { withKey = true } = {}) {
  const base = await (withKey ? startWithKey : startApprovalServer)(t, { spawnStartTimeoutMs: 2000, sessionControlTimeoutMs: 2000, transferMaxBytes: 100, transferUserQuotaBytes: 1000, transferChunkBytes: 10 })
  const { s, alice } = base
  const asker = createAgent(s.db, alice.id, 'box-a')
  const target = createAgent(s.db, alice.id, 'box-b')
  const coord = createAgent(s.db, alice.id, 'coord-box')
  upsertConversation(s.db, { id: 'ask', ownerUserId: alice.id, title: 'Asker', agentDeviceId: asker.deviceId })
  upsertConversation(s.db, { id: 'room', ownerUserId: alice.id, title: 'room', agentDeviceId: asker.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: alice.id, title: 'Coordinator', agentDeviceId: coord.deviceId })
  upsertConversation(s.db, { id: 'tgt', ownerUserId: alice.id, title: 'Target work', agentDeviceId: target.deviceId })
  setCoordinatorConvoId(s.db, alice.id, 'coord')
  const ws = {}
  for (const [k, dev] of [['asker', asker], ['target', target], ['coord', coord]]) {
    ws[k] = await makeWsClient(s.base, { token: dev.token, cursor: null })
    await ws[k].waitFor((f) => f.op === 'hello_ok')
  }
  ws.client = await makeWsClient(s.base, { token: base.token, cursor: null })
  await ws.client.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { for (const w of Object.values(ws)) { try { w.close() } catch { /* closed */ } } })
  const user = (p, opts = {}) => s.http(p, { token: base.token, ...opts })
  const protect = async (on = true) => {
    const body = { on }
    if (withKey) body.approval = await signAccount(s, { token: base.token, key: base.key, subject: { op: 'protect_device', device: String(target.deviceId), on: String(on) } })
    const r = await user(`/devices/${target.deviceId}/protected`, { method: 'POST', body })
    assert.equal(r.status, 200, JSON.stringify(r.json))
  }
  const parkSpawn = async (rid = 'q1') => {
    ws.asker.send({ op: 'spawn_request', request_id: rid, from_convo_id: 'ask', target_device_id: target.deviceId, workdir: WORKDIR, task: TASK, topic: 'flaky test' })
    return (await ws.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'pending' && x.request_id === rid)).spawn_id
  }
  const parkInvite = async () => {
    ws.asker.send({ op: 'agent_invite', room_id: 'room', target_device_id: target.deviceId, justification: 'need eyes on the diff', topic: 'review', from_convo_id: 'ask' })
    await ws.asker.waitFor((x) => x.kind === 'invite' && x.event === 'delivered' && x.room_id === 'room')
  }
  const pending = () => s.http('/consent/pending?convo_id=coord', { token: coord.token })
  const coordAnswer = (body) => s.http('/consent/answer', { method: 'POST', token: coord.token, body: { convo_id: 'coord', reason: 'routine', ...body } })
  const spawnAnswer = (id, decision, approval) => user('/agent-spawn/answer', { method: 'POST', body: { request_id: id, decision, ...(approval !== undefined ? { approval } : {}) } })
  const startRpc = () => ws.target.waitFor((f) => f.kind === 'rpc' && f.request?.method === 'start', 3000)
  const replyStart = (req) => ws.target.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { convo_id: 'child-1' } })
  // A file from box-a to box-b in the room, fully uploaded, so an approval
  // releases it at once.
  const sendFile = async () => {
    recordJoined(s.db, { convoId: 'room', agentDeviceId: target.deviceId, initiatorDeviceId: asker.deviceId })
    const created = await s.http('/transfers', {
      method: 'POST', token: asker.token,
      body: { room_id: 'room', from_convo_id: 'ask', name: 'notes.txt', size: 25, sha256: 'a'.repeat(64), content_type: 'text/plain', reason: 'the notes', scan: { verdict: 'clean', findings: [] } },
    })
    assert.equal(created.status, 201, JSON.stringify(created.json))
    s.db.prepare("UPDATE transfers SET upload='uploaded', uploaded_at=? WHERE id=?").run(Date.now(), created.json.transfer_id)
    return created.json.transfer_id
  }
  return { ...base, asker, target, coord, ws, user, protect, parkSpawn, parkInvite, pending, coordAnswer, spawnAnswer, startRpc, replyStart, sendFile }
}

const spawnSubject = (w, id) => ({ op: 'spawn', ask: id, box: 'box-b', workdir: WORKDIR, task_sha256: sha(TASK), decision: 'approve' })
const invalid = (r, reason) => assert.deepEqual([r.status, r.json], [400, { error: 'approval_invalid', reason }])
const required = (r) => assert.deepEqual([r.status, r.json], [403, { error: 'approval_required' }])
// A restamp reaches an app that syncs by `GET /items?since=` (the item's
// updated_at moves) and one that follows the journal (an `updated` marker).
const tick = () => new Promise((r) => setTimeout(r, 5))
const sinceIds = async (w, since) => (await w.user(`/items?label=consent&since=${since}`)).json.items.map((i) => i.id)
const updatedMarkers = (db, itemId) => db.prepare("SELECT payload FROM events WHERE type='item'").all()
  .map((r) => JSON.parse(r.payload)).filter((p) => p.action === 'updated' && p.item_id === itemId).length
const nonces = (w) => w.s.db.prepare('SELECT COUNT(*) n FROM approval_nonces WHERE used_at IS NOT NULL').get().n

test('consentSubject: the four shapes; a value over 200 characters goes in as <name>_sha256', () => {
  assert.deepEqual(consentSubject('spawn', { id: 'sp1', box: 'box-b', workdir: '/w', task: 'do it' }),
    { op: 'spawn', ask: 'sp1', box: 'box-b', workdir: '/w', task_sha256: sha('do it'), decision: 'approve' })
  assert.deepEqual(consentSubject('chat', { room_id: 'r1', device_id: 7, box: 'box-b', message: 'hi' }),
    { op: 'chat', ask: 'r1/7', box: 'box-b', message_sha256: sha('hi'), decision: 'approve' })
  assert.deepEqual(consentSubject('transfer', { id: 'tr_1', box: 'box-b', sha256: 'a'.repeat(64), size: 25 }),
    { op: 'transfer', ask: 'tr_1', box: 'box-b', file_sha256: 'a'.repeat(64), size: '25', decision: 'approve' })
  assert.deepEqual(consentSubject('start', { box: 'box-b', workdir: '', prompt: '' }),
    { op: 'start', box: 'box-b', workdir: '', prompt_sha256: sha('') })
  const long = '/w/' + 'x'.repeat(250)
  const s = consentSubject('spawn', { id: 'sp1', box: 'b'.repeat(201), workdir: long, task: 't' })
  assert.equal(s.workdir, undefined)
  assert.equal(s.workdir_sha256, sha(long))
  assert.equal(s.box_sha256, sha('b'.repeat(201)))
  assert.ok(Object.values(s).every((v) => typeof v === 'string' && v.length <= 200))
})

test('protected spawn target: listed step_up with its subject; the Coordinator is refused as for user-only; the user needs a signature, which reaches the box unchanged', async (t) => {
  const w = await world(t)
  await w.protect()
  const id = await w.parkSpawn()
  const row = (await w.pending()).json.pending.find((p) => p.id === id)
  assert.equal(row.user_only, true)
  assert.equal(row.step_up, true)
  assert.deepEqual(row.subject, spawnSubject(w, id))
  // The consent item carries the same.
  const item = (await w.user(`/items/${w.s.db.prepare('SELECT num FROM items WHERE id=?').get(getSpawn(w.s.db, id).item_id).num}`)).json.item
  assert.equal(item.step_up, true)
  assert.deepEqual(item.subject, spawnSubject(w, id))

  const coord = await w.coordAnswer({ kind: 'spawn', id, decision: 'approve' })
  assert.deepEqual([coord.status, coord.json], [403, { error: 'forbidden', detail: 'user_only' }])
  assert.equal(getSpawn(w.s.db, id).state, 'awaiting_user')

  required(await w.spawnAnswer(id, 'approve'))
  assert.equal(getSpawn(w.s.db, id).state, 'awaiting_user')
  // Signed for another ask: refused, nothing spent.
  const other = await signConsent(w.s, { token: w.token, key: w.key, subject: { ...spawnSubject(w, id), ask: 'sp_other' } })
  const spent = nonces(w)
  invalid(await w.spawnAnswer(id, 'approve', other), 'mismatch')
  assert.equal(nonces(w), spent)
  assert.equal(getSpawn(w.s.db, id).state, 'awaiting_user')

  const approval = await signConsent(w.s, { token: w.token, key: w.key, subject: row.subject })
  const ok = await w.spawnAnswer(id, 'approve', approval)
  assert.equal(ok.status, 200, JSON.stringify(ok.json))
  const req = await w.startRpc()
  assert.deepEqual(req.request.params.approval, approval)
  assert.equal(req.request.params.approval.statement, approval.statement)
  assert.equal(req.request.params.approval.signature, approval.signature)
  assert.equal(sha(req.request.params.prompt), row.subject.task_sha256)
  assert.equal(req.request.params.workdir, row.subject.workdir)
  w.replyStart(req)
  // Answering again is the usual 409, signature or not.
  assert.equal((await w.spawnAnswer(id, 'approve', approval)).status, 409)
})

test('protected spawn target: a decline needs no signature, and an approval sent with one is ignored', async (t) => {
  const w = await world(t)
  await w.protect()
  const id = await w.parkSpawn()
  const r = await w.spawnAnswer(id, 'deny', { statement: 'junk', signature: 'junk' })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(getSpawn(w.s.db, id).state, 'denied')
})

test('protected spawn target: the consent item tap needs the signature too', async (t) => {
  const w = await world(t)
  await w.protect()
  const id = await w.parkSpawn()
  const itemId = getSpawn(w.s.db, id).item_id
  const tap = (body) => w.user(`/items/${itemId}/comments`, { method: 'POST', body })
  required(await tap({ action: 'Approve' }))
  assert.equal(getSpawn(w.s.db, id).state, 'awaiting_user')
  const approval = await signConsent(w.s, { token: w.token, key: w.key, subject: spawnSubject(w, id) })
  const r = await tap({ action: 'Approve', approval })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const req = await w.startRpc()
  assert.deepEqual(req.request.params.approval, approval)
  w.replyStart(req)
})

test('an unprotected target with a keyed account: no step_up, no signature, and the start params are today\'s', async (t) => {
  const w = await world(t)
  const id = await w.parkSpawn()
  const row = (await w.pending()).json.pending.find((p) => p.id === id)
  assert.equal('step_up' in row, false)
  assert.equal('subject' in row, false)
  assert.equal('user_only' in row, false)
  const approval = await signConsent(w.s, { token: w.token, key: w.key, subject: spawnSubject(w, id) })
  assert.equal((await w.spawnAnswer(id, 'approve', approval)).status, 200)
  const req = await w.startRpc()
  assert.equal('approval' in req.request.params, false)
  w.replyStart(req)
})

test('protected chat invitee: the user\'s approval needs a signature over the room, the box and the message; the invite carries it', async (t) => {
  const w = await world(t)
  await w.protect()
  await w.parkInvite()
  const askId = `room/${w.target.deviceId}`
  const row = (await w.pending()).json.pending.find((p) => p.id === askId)
  const subject = { op: 'chat', ask: askId, box: 'box-b', message_sha256: sha('need eyes on the diff'), decision: 'approve' }
  assert.equal(row.step_up, true)
  assert.deepEqual(row.subject, subject)
  const coord = await w.coordAnswer({ kind: 'chat', id: askId, decision: 'approve' })
  assert.deepEqual([coord.status, coord.json], [403, { error: 'forbidden', detail: 'user_only' }])
  const answer = (approval) => w.user('/agent-chat/answer', { method: 'POST', body: { room_id: 'room', target_device_id: w.target.deviceId, decision: 'approve', ...(approval ? { approval } : {}) } })
  required(await answer())
  assert.equal(getParticipant(w.s.db, 'room', w.target.deviceId).state, 'awaiting_user')
  const approval = await signConsent(w.s, { token: w.token, key: w.key, subject })
  const r = await answer(approval)
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const frame = await w.ws.target.waitFor((f) => f.kind === 'invite' && f.event === 'request' && f.room_id === 'room')
  assert.deepEqual(frame.approval, approval)
})

test('protected chat invitee: the consent item tap needs the signature; a decline does not', async (t) => {
  const w = await world(t)
  await w.protect()
  await w.parkInvite()
  const itemId = getParticipant(w.s.db, 'room', w.target.deviceId).item_id
  required(await w.user(`/items/${itemId}/comments`, { method: 'POST', body: { action: 'Approve' } }))
  const r = await w.user(`/items/${itemId}/comments`, { method: 'POST', body: { action: 'Decline' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  assert.equal(getParticipant(w.s.db, 'room', w.target.deviceId).state, 'denied')
})

test('protected transfer recipient: the tap needs a signature over the file\'s hash and size; the released transfer carries it', async (t) => {
  const w = await world(t)
  await w.protect()
  const id = await w.sendFile()
  const subject = { op: 'transfer', ask: id, box: 'box-b', file_sha256: 'a'.repeat(64), size: '25', decision: 'approve' }
  const row = (await w.pending()).json.pending.find((p) => p.id === id)
  assert.equal(row.step_up, true)
  assert.deepEqual(row.subject, subject)
  const item = w.s.db.prepare('SELECT step_up, subject FROM items WHERE id=?').get(getTransfer(w.s.db, id).item_id)
  assert.equal(item.step_up, 1)
  assert.deepEqual(JSON.parse(item.subject), subject)
  const tap = (body) => w.user(`/items/${getTransfer(w.s.db, id).item_id}/comments`, { method: 'POST', body })
  required(await tap({ action: 'Approve' }))
  assert.equal(getTransfer(w.s.db, id).consent, 'awaiting_user')
  const approval = await signConsent(w.s, { token: w.token, key: w.key, subject })
  const r = await tap({ action: 'Approve', approval })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const ready = await w.ws.target.waitFor((f) => f.kind === 'transfer' && f.event === 'ready' && f.transfer_id === id)
  assert.deepEqual(ready.transfer.approval, approval)
  const listed = await w.s.http('/transfers?for=me', { token: w.target.token })
  assert.deepEqual(listed.json.transfers.find((x) => x.id === id).approval, approval)
})

for (const withKey of [true, false]) {
  test(`session control into a protected box is refused protected_device (${withKey ? 'with' : 'without'} an approval key)`, async (t) => {
    const w = await world(t, { withKey })
    await w.protect()
    w.ws.coord.send({ op: 'session_control', request_id: 'sc1', from_convo_id: 'coord', target_convo_id: 'tgt', action: 'compact' })
    const err = await w.ws.coord.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.ref === 'session_control')
    assert.equal(err.code, 'forbidden')
    assert.equal(err.detail, 'protected_device')
    assert.equal(w.ws.target.frames.some((f) => f.kind === 'rpc'), false)
  })
}

test('the Coordinator\'s approval of a transfer to a protected box is refused as user-only, and nothing is released', async (t) => {
  const w = await world(t)
  await w.protect()
  const id = await w.sendFile()
  const r = await w.coordAnswer({ kind: 'transfer', id, decision: 'approve' })
  assert.deepEqual([r.status, r.json], [403, { error: 'forbidden', detail: 'user_only' }])
  assert.equal(getTransfer(w.s.db, id).consent, 'awaiting_user')
  assert.equal(w.ws.target.frames.some((f) => f.kind === 'transfer'), false)
})

test('no approval key: the approved chat invite and the released transfer to a protected box carry no approval', async (t) => {
  const w = await world(t, { withKey: false })
  await w.protect()
  await w.parkInvite()
  const r = await w.user('/agent-chat/answer', { method: 'POST', body: { room_id: 'room', target_device_id: w.target.deviceId, decision: 'approve' } })
  assert.equal(r.status, 200, JSON.stringify(r.json))
  const frame = await w.ws.target.waitFor((f) => f.kind === 'invite' && f.event === 'request' && f.room_id === 'room')
  assert.equal('approval' in frame, false)
  // The invitee joins, so the room's file goes to it.
  w.ws.target.send({ op: 'agent_invite_answer', room_id: 'room', accept: true })
  await w.ws.asker.waitFor((f) => f.kind === 'invite' && f.event === 'answer' && f.room_id === 'room')
  const created = await w.s.http('/transfers', {
    method: 'POST', token: w.asker.token,
    body: { room_id: 'room', from_convo_id: 'ask', name: 'notes.txt', size: 25, sha256: 'a'.repeat(64), content_type: 'text/plain', reason: 'the notes', scan: { verdict: 'clean', findings: [] } },
  })
  assert.equal(created.status, 201, JSON.stringify(created.json))
  const id = created.json.transfer_id
  w.s.db.prepare("UPDATE transfers SET upload='uploaded', uploaded_at=? WHERE id=?").run(Date.now(), id)
  const tap = await w.user(`/items/${getTransfer(w.s.db, id).item_id}/comments`, { method: 'POST', body: { action: 'Approve' } })
  assert.equal(tap.status, 200, JSON.stringify(tap.json))
  const ready = await w.ws.target.waitFor((f) => f.kind === 'transfer' && f.event === 'ready' && f.transfer_id === id)
  assert.equal('approval' in ready.transfer, false)
  const listed = await w.s.http('/transfers?for=me', { token: w.target.token })
  assert.equal('approval' in listed.json.transfers.find((x) => x.id === id), false)
})

test('renaming a protected box restamps the open consent items that name it', async (t) => {
  const w = await world(t)
  await w.protect()
  const id = await w.parkSpawn()
  const itemId = getSpawn(w.s.db, id).item_id
  const r = await w.user(`/devices/${w.target.deviceId}/rename`, { method: 'POST', body: { name: 'box-z' } })
  assert.equal(r.status, 200)
  const item = (await w.user(`/items/${itemId}`)).json.item
  assert.deepEqual(item.subject, { ...spawnSubject(w, id), box: 'box-z' })
  const row = (await w.pending()).json.pending.find((p) => p.id === id)
  assert.deepEqual(row.subject, item.subject)
  const marker = JSON.parse(w.s.db.prepare("SELECT payload FROM events WHERE type='item' ORDER BY seq DESC LIMIT 1").get().payload)
  assert.equal(marker.action, 'updated')
  assert.equal(marker.item_id, itemId)
})

test('a client\'s direct start on a protected box is an account action; the box gets the params unchanged', async (t) => {
  const w = await world(t)
  await w.protect()
  const params = { workdir: WORKDIR, prompt: 'look at the logs' }
  const errOf = (rid) => w.ws.client.waitFor((f) => f.kind === 'control' && f.op === 'error' && f.request_id === rid)
  w.ws.client.send({ op: 'agent_request', request_id: 'r1', agent_device_id: w.target.deviceId, method: 'start', params })
  assert.equal((await errOf('r1')).code, 'approval_required')
  const subject = { op: 'start', box: 'box-b', workdir: WORKDIR, prompt_sha256: sha('look at the logs') }
  const wrong = await signAccount(w.s, { token: w.token, key: w.key, subject: { ...subject, prompt_sha256: sha('something else') } })
  w.ws.client.send({ op: 'agent_request', request_id: 'r2', agent_device_id: w.target.deviceId, method: 'start', params: { ...params, approval: wrong } })
  const e2 = await errOf('r2')
  assert.equal(e2.code, 'approval_invalid')
  assert.equal(e2.detail, 'mismatch')
  // A consent statement is not an account one.
  const consent = await signConsent(w.s, { token: w.token, key: w.key, subject })
  // Two invalid approvals from one device would sign it out
  // (test/approval-lockdown.test.js): this one is checked on its own.
  forgetApprovalFailures(w.s)
  w.ws.client.send({ op: 'agent_request', request_id: 'r3', agent_device_id: w.target.deviceId, method: 'start', params: { ...params, approval: consent } })
  assert.equal((await errOf('r3')).detail, 'mismatch')
  assert.equal(w.ws.target.frames.some((f) => f.kind === 'rpc'), false)
  const approval = await signAccount(w.s, { token: w.token, key: w.key, subject })
  w.ws.client.send({ op: 'agent_request', request_id: 'r4', agent_device_id: w.target.deviceId, method: 'start', params: { ...params, approval } })
  const req = await w.startRpc()
  assert.deepEqual(req.request.params, { ...params, approval })
  // Other methods on the box are untouched.
  w.ws.client.send({ op: 'agent_request', request_id: 'r5', agent_device_id: w.target.deviceId, method: 'recent_folders', params: {} })
  await w.ws.target.waitFor((f) => f.kind === 'rpc' && f.request?.request_id === 'r5')
})

test('no approval key: a protected box behaves as a user-only one, with no signature anywhere', async (t) => {
  const w = await world(t, { withKey: false })
  await w.protect()
  const id = await w.parkSpawn()
  const row = (await w.pending()).json.pending.find((p) => p.id === id)
  assert.equal(row.user_only, true)
  assert.equal('step_up' in row, false)
  assert.equal('subject' in row, false)
  assert.equal(w.s.db.prepare('SELECT step_up FROM items WHERE id=?').get(getSpawn(w.s.db, id).item_id).step_up, 0)
  const coord = await w.coordAnswer({ kind: 'spawn', id, decision: 'approve' })
  assert.deepEqual([coord.status, coord.json], [403, { error: 'forbidden', detail: 'user_only' }])
  assert.equal((await w.spawnAnswer(id, 'approve')).status, 200)
  const req = await w.startRpc()
  assert.equal('approval' in req.request.params, false)
  w.replyStart(req)
  w.ws.client.send({ op: 'agent_request', request_id: 'd1', agent_device_id: w.target.deviceId, method: 'start', params: { workdir: '', prompt: 'hi' } })
  await w.ws.target.waitFor((f) => f.kind === 'rpc' && f.request?.request_id === 'd1')
})

test('POST /devices/:id/protected: client only, own agent boxes only, signed once a key exists; GET /devices shows it', async (t) => {
  const w = await world(t)
  const url = `/devices/${w.target.deviceId}/protected`
  assert.equal((await w.s.http(url, { method: 'POST', token: w.asker.token, body: { on: true } })).status, 403)
  assert.equal((await w.user(url, { method: 'POST', body: { on: 'yes' } })).status, 400)
  assert.equal((await w.user(`/devices/${w.deviceId}/protected`, { method: 'POST', body: { on: true } })).status, 404)
  const bob = await createUser(w.s.db, 'bob', 'pw')
  const bobBox = createAgent(w.s.db, bob.id, 'box-c')
  assert.equal((await w.user(`/devices/${bobBox.deviceId}/protected`, { method: 'POST', body: { on: true } })).status, 404)
  required(await w.user(url, { method: 'POST', body: { on: true } }))
  const subject = { op: 'protect_device', device: String(w.target.deviceId), on: 'true' }
  const off = await signAccount(w.s, { token: w.token, key: w.key, subject: { ...subject, on: 'false' } })
  invalid(await w.user(url, { method: 'POST', body: { on: true, approval: off } }), 'mismatch')
  const devices = async () => (await w.user('/devices')).json.devices
  assert.equal((await devices()).find((d) => d.device_id === w.target.deviceId).protected, false)
  const approval = await signAccount(w.s, { token: w.token, key: w.key, subject })
  const r = await w.user(url, { method: 'POST', body: { on: true, approval } })
  assert.deepEqual([r.status, r.json], [200, { ok: true, device_id: w.target.deviceId, protected: true }])
  const list = await devices()
  assert.equal(list.find((d) => d.device_id === w.target.deviceId).protected, true)
  assert.equal(list.find((d) => d.device_id === w.asker.deviceId).protected, false)
  // The user-only flag is its own.
  assert.equal(w.s.db.prepare('SELECT consent_user_only FROM devices WHERE id=?').get(w.target.deviceId).consent_user_only, 0)
  await w.protect(false)
  assert.equal((await devices()).find((d) => d.device_id === w.target.deviceId).protected, false)
})

test('protecting a box restamps the open consent items aimed at it', async (t) => {
  const w = await world(t)
  const id = await w.parkSpawn()
  const itemId = getSpawn(w.s.db, id).item_id
  const stamp = () => w.s.db.prepare('SELECT step_up, subject FROM items WHERE id=?').get(itemId)
  assert.equal(stamp().step_up, 0)
  await tick()
  let since = Date.now()
  await w.protect()
  assert.equal(stamp().step_up, 1)
  assert.deepEqual(JSON.parse(stamp().subject), spawnSubject(w, id))
  assert.deepEqual(await sinceIds(w, since), [itemId])
  assert.equal(updatedMarkers(w.s.db, itemId), 1)
  await tick()
  since = Date.now()
  await w.protect(false)
  assert.deepEqual(stamp(), { step_up: 0, subject: null })
  assert.deepEqual(await sinceIds(w, since), [itemId])
  assert.equal(updatedMarkers(w.s.db, itemId), 2)
})

test('the account\'s first approval key restamps the open consent items aimed at a protected box', async (t) => {
  const w = await world(t, { withKey: false })
  await w.protect()
  const id = await w.parkSpawn()
  const itemId = getSpawn(w.s.db, id).item_id
  assert.equal(w.s.db.prepare('SELECT step_up FROM items WHERE id=?').get(itemId).step_up, 0)
  const { secret } = await enableTwoFactor(w.s, w.token)
  await tick()
  const since = Date.now()
  const key = await enrolKeyByPassword(w.s, { token: w.token, userId: w.alice.id, secret })
  const item = (await w.user(`/items/${itemId}`)).json.item
  assert.equal(item.step_up, true)
  assert.deepEqual(item.subject, spawnSubject(w, id))
  assert.ok((await sinceIds(w, since)).includes(itemId), 'an app syncing by since sees the new mark')
  assert.equal(updatedMarkers(w.s.db, itemId), 1)
  required(await w.spawnAnswer(id, 'approve'))
  // The last key removed: back to unsigned, and said so the same way.
  await tick()
  const since2 = Date.now()
  const approval = await signAccount(w.s, { token: w.token, key, subject: { op: 'revoke_key', key_id: key.keyId } })
  assert.equal((await w.user(`/approval-keys/${key.keyId}/revoke`, { method: 'POST', body: { approval } })).status, 200)
  const after = (await w.user(`/items/${itemId}`)).json.item
  assert.deepEqual([after.step_up, after.subject], [false, null])
  assert.ok((await sinceIds(w, since2)).includes(itemId))
  assert.equal(updatedMarkers(w.s.db, itemId), 2)
})

test('matron-admin device protected restamps the open consent items, moving their updated_at and filing the marker', async (t) => {
  const w = await world(t)
  const id = await w.parkSpawn()
  const itemId = getSpawn(w.s.db, id).item_id
  await tick()
  const since = Date.now()
  await runAdmin(w.s.db, ['device', 'protected', String(w.target.deviceId), 'on'])
  const item = (await w.user(`/items/${itemId}`)).json.item
  assert.equal(item.step_up, true)
  assert.deepEqual(await sinceIds(w, since), [itemId])
  assert.equal(updatedMarkers(w.s.db, itemId), 1)
})

test('an item hand-over to or from a protected box needs the user\'s tap, as for a user-only one', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'alice', 'pw')
  const a = createAgent(db, u.id, 'box-a')
  const b = createAgent(db, u.id, 'box-b')
  assert.equal(needsUserTap(db, u.id, a.deviceId, b.deviceId), false)
  setDeviceProtected(db, b.deviceId, true)
  assert.equal(needsUserTap(db, u.id, a.deviceId, b.deviceId), true)
  db.close()
})

test('matron-admin device protected toggles the flag and device list shows it', async () => {
  const db = openDb(':memory:')
  const u = await createUser(db, 'alice', 'pw')
  const a = createAgent(db, u.id, 'box-a')
  assert.match(await runAdmin(db, ['device', 'protected', String(a.deviceId), 'on']), /protected/)
  assert.equal(db.prepare('SELECT protected FROM devices WHERE id=?').get(a.deviceId).protected, 1)
  assert.match(await runAdmin(db, ['device', 'list', 'alice']), /name=box-a .* protected/)
  await runAdmin(db, ['device', 'protected', String(a.deviceId), 'off'])
  assert.equal(db.prepare('SELECT protected FROM devices WHERE id=?').get(a.deviceId).protected, 0)
  assert.doesNotMatch(await runAdmin(db, ['device', 'list', 'alice']), /protected/)
  await assert.rejects(() => runAdmin(db, ['device', 'protected', '999', 'on']), /no such device/)
  await assert.rejects(() => runAdmin(db, ['device', 'protected', String(a.deviceId), 'maybe']), /usage/i)
  db.close()
})
