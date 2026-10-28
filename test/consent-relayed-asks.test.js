import test from 'node:test'
import assert from 'node:assert/strict'
import { getSpawn } from '../src/spawns.js'
import { getParticipant, inviteParticipant, answerInvite } from '../src/participants.js'
import { append } from '../src/journal.js'
import { WHY_RELAY_UNCHECKED } from '../src/cause-hops.js'
import { fleet, parkSpawn, parkInviteAsk, answer } from './consent-fleet.js'

// An ask another session made because the Coordinator had it made — by a
// carry-on, or a room message — is approved by the Coordinator only on the
// rule its own asks meet (src/cause-hops.js, src/consent-own-ask.js). Asks
// the Coordinator had no hand in are answered exactly as before.

function stubVerifier() {
  const calls = []
  return { calls, enabled: true, verify: async (args) => { calls.push(args); return { ok: true, approve: true, note: 'fine' } } }
}
function autoStart(f) {
  f.target.ws.on('message', (d) => {
    const x = JSON.parse(d)
    if (x.kind === 'rpc' && x.request?.method === 'start') {
      f.target.send({ op: 'agent_response', request_id: x.request.request_id, to_device_id: 0, ok: true, result: { convo_id: `child-${x.request.request_id}` } })
    }
  })
}
const userSays = (f, body = 'ask the other session to start a helper on opal') => {
  const { seq } = append(f.s.db, { userId: f.alice.id, convoId: 'coord', sender: 'user:alice', type: 'text', payload: { body } })
  return [{ kind: 'user_message', ref: `coord:${seq}` }]
}
const decisions = (f) => f.s.db.prepare('SELECT kind, ask_id, decision, cause_kind, cause_ref FROM consent_decisions ORDER BY id').all()
const approve = (f, kind, id) => answer(f, f.coordDev.token, { kind, id, decision: 'approve', reason: 'the session asked' })

// The Coordinator carries the asker's session on; the asker's bridge
// answers the RPC as a target would. → the carry_on cause its turn names.
let n = 0
async function carryOn(f, causes) {
  const rid = `co${++n}`
  f.coord.send({ op: 'session_control', request_id: rid, from_convo_id: 'coord', target_convo_id: 'ask', action: 'carry_on', message: 'start a helper on opal', ...(causes ? { causes } : {}) })
  const req = await f.asker.waitFor((x) => x.kind === 'rpc' && x.request?.method === 'session_control' && x.request.params.message === 'start a helper on opal' && !x._seen)
  req._seen = true
  f.asker.send({ op: 'agent_response', request_id: req.request.request_id, to_device_id: 0, ok: true, result: { applied: 'now' } })
  await f.coord.waitFor((x) => x.kind === 'session_control' && x.event === 'result' && x.request_id === rid)
  return [{ kind: 'carry_on', ref: `carry_on:${req.request.params.carry_on_id}` }]
}

test('a spawn asked in a carry-on turn on the user\'s words: approved on the user root', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  autoStart(f)
  const said = userSays(f)
  const causes = await carryOn(f, said)
  const id = await parkSpawn(f, { causes })
  const r = await approve(f, 'spawn', id)
  assert.equal(r.status, 200)
  await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome' && x.request_id === id)
  assert.deepEqual(decisions(f), [{ kind: 'spawn', ask_id: id, decision: 'approve', cause_kind: 'user', cause_ref: said[0].ref }])
})

test('a spawn asked in a carry-on turn the Coordinator sent on nothing the user did: 403, the ask stays for the user', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  const causes = await carryOn(f, [{ kind: 'room_message', ref: 'room:elsewhere' }])
  const id = await parkSpawn(f, { causes })
  const r = await approve(f, 'spawn', id)
  assert.equal(r.status, 403)
  assert.equal(r.json.detail, 'own_ask_unverified')
  assert.equal(r.json.why, `relayed from the Coordinator (${causes[0].ref}): started by room_message`)
  assert.equal(getSpawn(f.s.db, id).state, 'awaiting_user')
  assert.deepEqual(decisions(f), [])
  // The user's tap still answers it.
  const tap = await f.s.http('/agent-spawn/answer', { method: 'POST', token: f.clientToken, body: { request_id: id, decision: 'deny' } })
  assert.equal(tap.status, 200)
})

test('the user\'s switch for Coordinator file approvals does not reach spawns: a relayed spawn is still 403', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  assert.equal((await f.s.http('/coordinator', { method: 'PUT', token: f.clientToken, body: { transfer_consent: true } })).status, 200)
  const causes = await carryOn(f, [{ kind: 'room_message', ref: 'room:elsewhere' }])
  const id = await parkSpawn(f, { causes })
  const r = await approve(f, 'spawn', id)
  assert.equal(r.status, 403)
  assert.equal(r.json.detail, 'own_ask_unverified')
  assert.equal(getSpawn(f.s.db, id).state, 'awaiting_user')
})

test('a carry-on cause with no ref, or one sent to another session, is 403 unchecked', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  const bare = await parkSpawn(f, { rid: 'q1', causes: [{ kind: 'carry_on' }] })
  assert.deepEqual((await approve(f, 'spawn', bare)).json, { error: 'forbidden', detail: 'own_ask_unverified', why: WHY_RELAY_UNCHECKED })
  // A carry-on the Coordinator sent to the asker, cited from another of the
  // asker's sessions.
  const causes = await carryOn(f, userSays(f))
  const { upsertConversation } = await import('../src/journal.js')
  upsertConversation(f.s.db, { id: 'ask-2', ownerUserId: f.alice.id, title: 'Asker 2', agentDeviceId: f.askerDev.deviceId })
  const forged = await parkSpawn(f, { rid: 'q2', from: 'ask-2', causes })
  assert.deepEqual((await approve(f, 'spawn', forged)).json, { error: 'forbidden', detail: 'own_ask_unverified', why: WHY_RELAY_UNCHECKED })
})

test('an ordinary ask between sessions is answered as before, whatever its causes', async (t) => {
  const verifier = stubVerifier()
  const f = await fleet(t, { verifier })
  autoStart(f)
  const { seq } = append(f.s.db, { userId: f.alice.id, convoId: 'ask', sender: 'agent:asker-box', type: 'text', payload: { body: 'thinking' } })
  const id = await parkSpawn(f, { causes: [{ kind: 'room_message', ref: 'room:room' }, { kind: 'user_message', ref: `ask:${seq}` }, { kind: 'reminder' }] })
  assert.equal((await approve(f, 'spawn', id)).status, 200)
  await f.asker.waitFor((x) => x.kind === 'spawn' && x.event === 'outcome' && x.request_id === id)
  assert.deepEqual(decisions(f), [{ kind: 'spawn', ask_id: id, decision: 'approve', cause_kind: null, cause_ref: null }])
  assert.equal(verifier.calls.length, 0)
})

test('a chat ask made on the Coordinator\'s room message: the publish is recorded, and the ask needs the Coordinator\'s root', async (t) => {
  const f = await fleet(t, { verifier: stubVerifier() })
  // The asker's room, with the Coordinator's session in it.
  inviteParticipant(f.s.db, { convoId: 'room', agentDeviceId: f.coordDev.deviceId, initiatorDeviceId: f.askerDev.deviceId, targetConvoId: 'coord', initiatorConvoId: 'ask' })
  answerInvite(f.s.db, { convoId: 'room', agentDeviceId: f.coordDev.deviceId, accept: true })
  const publish = async (causes, extra = {}) => {
    const before = f.s.db.prepare('SELECT MAX(seq) AS m FROM events').get().m
    f.coord.send({ op: 'publish', convo_id: 'room', type: 'text', payload: { body: 'open a room with opal' }, from_convo_id: 'coord', ...(causes ? { causes } : {}), ...extra })
    for (let i = 0; i < 50; i++) {
      const row = f.s.db.prepare("SELECT seq FROM events WHERE convo_id='room' AND seq>? ORDER BY seq DESC").get(before ?? 0)
      if (row) return row.seq
      await new Promise((r) => setTimeout(r, 20))
    }
    throw new Error('publish did not land')
  }
  // On nothing the user did: the asker's chat ask is refused.
  const bad = await publish(null)
  assert.equal(f.s.db.prepare("SELECT coordinator FROM cause_hops WHERE key=?").get(`room:room@${bad}`).coordinator, 1)
  await parkInviteAsk(f, { causes: [{ kind: 'room_message', ref: `room:room@${bad}` }] })
  const id = `room/${f.targetDev.deviceId}`
  const r = await approve(f, 'chat', id)
  assert.equal(r.status, 403)
  assert.match(r.json.why, /^relayed from the Coordinator \(room:room@\d+\): the ask carries no turn cause/)
  assert.equal(getParticipant(f.s.db, 'room', f.targetDev.deviceId).state, 'awaiting_user')
  // Declined, asked again after the Coordinator spoke on the user's words.
  await answer(f, f.coordDev.token, { kind: 'chat', id, decision: 'decline', reason: 'not on that' })
  const said = userSays(f, 'have the other session open a room with opal')
  const good = await publish(said)
  await parkInviteAsk(f, { causes: [{ kind: 'room_message', ref: `room:room@${good}` }] })
  const ok = await approve(f, 'chat', id)
  assert.equal(ok.status, 200)
  assert.equal(decisions(f).find((d) => d.decision === 'approve').cause_ref, said[0].ref)
  // A publish naming no session is no hop, as from an older bridge.
  const plain = await publish(said, { from_convo_id: undefined })
  assert.equal(f.s.db.prepare('SELECT 1 FROM cause_hops WHERE key=?').get(`room:room@${plain}`), undefined)
})
