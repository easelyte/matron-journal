// Shared fleet for the consent-approval tests (split in two files so each
// stays under the harness's 30 s file budget).
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'

// Coordinator consent approval (spec: matron-bridge
// docs/superpowers/specs/2026-09-29-coordinator-consent-design.md): the
// user's Coordinator lists and answers parked chat and spawn asks through
// two agent routes gated on user_settings.coordinator_convo_id, with the
// guardrails (off switch, reason, daily cap, offline target) and the audit
// trail (answered_by, consent item comment, decided_by on the outcome, a
// client-only consent_decision event, a nudge frame to the Coordinator).
export async function fleet(t, serverOpts = {}) {
  const s = await startTestServer(serverOpts)
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const coordDev = createAgent(s.db, dan.id, 'coord-box')
  const askerDev = createAgent(s.db, dan.id, 'asker-box')
  const targetDev = createAgent(s.db, dan.id, 'eric')
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', agentDeviceId: coordDev.deviceId })
  upsertConversation(s.db, { id: 'ask', ownerUserId: dan.id, title: 'Asker', agentDeviceId: askerDev.deviceId })
  upsertConversation(s.db, { id: 'room', ownerUserId: dan.id, title: 'room', agentDeviceId: askerDev.deviceId })
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const clientToken = login.json.token
  const coord = await makeWsClient(s.base, { token: coordDev.token, cursor: null })
  const asker = await makeWsClient(s.base, { token: askerDev.token, cursor: null })
  const target = await makeWsClient(s.base, { token: targetDev.token, cursor: null })
  const client = await makeWsClient(s.base, { token: clientToken, cursor: null })
  for (const w of [coord, asker, target, client]) await w.waitFor((f) => f.op === 'hello_ok')
  t.after(() => { for (const w of [coord, asker, target, client]) { try { w.close() } catch { /* closed by the test */ } } })
  assert.equal((await s.http('/coordinator', { method: 'PUT', token: clientToken, body: { convo_id: 'coord' } })).status, 200)
  for (const w of [coord, asker, target, client]) w.frames.length = 0
  return { s, dan, coordDev, askerDev, targetDev, clientToken, coord, asker, target, client }
}
export const parkSpawn = async (f, { rid = 'q1', from = 'ask', ws = null } = {}) => {
  (ws || f.asker).send({ op: 'spawn_request', request_id: rid, from_convo_id: from, target_device_id: f.targetDev.deviceId, workdir: '/home/dan/proj', task: 'fix the flaky test', topic: 'flaky test' })
  const ack = await (ws || f.asker).waitFor((x) => x.kind === 'spawn' && x.event === 'pending' && x.request_id === rid)
  return ack.spawn_id
}
export const parkInviteAsk = async (f) => {
  f.asker.send({ op: 'agent_invite', room_id: 'room', target_device_id: f.targetDev.deviceId, justification: 'need eyes on the diff', topic: 'review', from_convo_id: 'ask' })
  await f.asker.waitFor((x) => x.kind === 'invite' && x.event === 'delivered')
}
export const pending = (f, token, convoId = 'coord') => f.s.http(`/consent/pending?convo_id=${encodeURIComponent(convoId)}`, { token })
export const answer = (f, token, body) => f.s.http('/consent/answer', { method: 'POST', token, body: { convo_id: 'coord', ...body } })
export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms))

