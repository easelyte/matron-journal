import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'
import { pinDevicePrivate } from '../src/db.js'
import { setCoordinatorConvoId } from '../src/coordinator.js'
import { createItem } from '../src/items.js'
import { seenRanges } from '../src/seen.js'

async function fleet(t) {
  const s = await startTestServer({ unseenNudge: false })
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const pat = await createUser(s.db, 'pat', 'pw')
  const ang = createAgent(s.db, dan.id, 'ang')
  const bev = createAgent(s.db, dan.id, 'bev')
  const priv = createAgent(s.db, dan.id, 'priv-box')
  pinDevicePrivate(s.db, priv.deviceId, true)
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: ang.deviceId })
  upsertConversation(s.db, { id: 'b1', ownerUserId: dan.id, title: 'B1', agentDeviceId: bev.deviceId })
  upsertConversation(s.db, { id: 'coord', ownerUserId: dan.id, title: 'Coordinator', agentDeviceId: bev.deviceId })
  upsertConversation(s.db, { id: 'pc', ownerUserId: dan.id, title: 'Private', agentDeviceId: priv.deviceId })
  upsertConversation(s.db, { id: 'p1', ownerUserId: pat.id, title: 'P1', agentDeviceId: patAgent.deviceId })
  setCoordinatorConvoId(s.db, dan.id, 'coord')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  const say = (convoId, body, sender) => append(s.db, { userId: dan.id, convoId, sender, type: 'text', payload: { body, from: 'assistant' } }).seq
  return { s, dan, ang, bev, priv, patAgent, client: login.json.token, say }
}
const get = (s, token, qs) => s.http(`/unseen?${new URLSearchParams(qs)}`, { token })

test('GET /unseen: the Coordinator sees everything unseen; others are refused', async (t) => {
  const { s, ang, bev, client, patAgent, say } = await fleet(t)
  const a = say('c1', 'from ang', 'agent:ang')
  say('b1', 'from bev', 'agent:bev')
  say('pc', 'private', 'agent:priv-box')
  const r = await get(s, bev.token, { convo_id: 'coord', older_than_ms: 0, importance: 'all' })
  assert.equal(r.status, 200)
  const refs = r.json.entries.map((e) => e.ref)
  assert.ok(refs.includes(`msg:c1:${a}`)); assert.ok(refs.some((x) => x.startsWith('msg:b1:')))
  assert.ok(!refs.some((x) => x.startsWith('msg:pc:'))) // ordinary Coordinator: private rooms stay out
  assert.equal(r.json.truncated, false)
  // in_convo_id narrows.
  const one = await get(s, bev.token, { convo_id: 'coord', older_than_ms: 0, importance: 'all', in_convo_id: 'c1' })
  assert.deepEqual(one.json.entries.map((e) => e.ref), [`msg:c1:${a}`])
  // Not the Coordinator, not its conversation, a client, junk.
  const notCoord = await get(s, ang.token, { convo_id: 'c1' }) // ang's own conversation, but not the Coordinator
  assert.equal(notCoord.status, 403); assert.equal(notCoord.json.detail, 'not_coordinator')
  assert.equal((await get(s, ang.token, { convo_id: 'coord' })).status, 404) // not ang's conversation
  assert.equal((await get(s, client, { convo_id: 'coord' })).status, 403)
  assert.equal((await get(s, patAgent.token, { convo_id: 'coord' })).status, 404)
  assert.equal((await get(s, bev.token, { convo_id: 'coord', importance: 'loud' })).status, 400)
  assert.equal((await get(s, bev.token, { convo_id: 'coord', limit: '0' })).status, 400)
  assert.equal((await get(s, bev.token, { convo_id: 'coord', since_ms: '-1' })).status, 400)
  assert.equal((await get(s, bev.token, {})).status, 400)
})

test('GET /unseen: a non-Coordinator agent that owns the convo gets 403 not_coordinator', async (t) => {
  const { s, bev, dan } = await fleet(t)
  setCoordinatorConvoId(s.db, dan.id, null)
  const r = await get(s, bev.token, { convo_id: 'b1' })
  assert.equal(r.status, 403); assert.equal(r.json.detail, 'not_coordinator')
})

test('GET /unseen?mine=1: any agent, its own messages in its own conversation only', async (t) => {
  const { s, ang, bev, dan, say } = await fleet(t)
  const mine = say('c1', 'from ang', 'agent:ang')
  say('c1', 'from a peer', 'agent:bev')
  createItem(s.db, { userId: dan.id, kind: 'question', title: 'Q', awaiting: 'user', originConvoId: 'c1', originDeviceId: ang.deviceId, createdBy: 'agent' })
  const r = await get(s, ang.token, { convo_id: 'c1', mine: '1', older_than_ms: 0 })
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.entries.map((e) => e.ref), [`msg:c1:${mine}`])
  assert.equal((await get(s, ang.token, { convo_id: 'b1', mine: '1' })).status, 404) // not ang's to write
})

test('POST /unseen/flags: the Coordinator flags anything; an agent only its own messages', async (t) => {
  const { s, ang, bev, say } = await fleet(t)
  const a = say('c1', 'from ang', 'agent:ang')
  const b = say('c1', 'from bev', 'agent:bev')
  const post = (token, body) => s.http('/unseen/flags', { method: 'POST', token, body })
  let r = await post(bev.token, { convo_id: 'coord', refs: [`msg:c1:${b}`, `msg:c1:${b}`] })
  assert.equal(r.status, 200); assert.equal(r.json.flagged, 1)
  r = await get(s, bev.token, { convo_id: 'coord', older_than_ms: 0, importance: 'all' })
  assert.deepEqual(r.json.entries.map((e) => e.ref), [`msg:c1:${a}`])
  assert.equal((await post(ang.token, { convo_id: 'c1', refs: [`msg:c1:${b}`] })).status, 403) // bev's message
  assert.equal((await post(ang.token, { convo_id: 'c1', refs: [`msg:c1:${a}`] })).status, 200)
  assert.equal((await post(ang.token, { convo_id: 'c1', refs: ['nonsense'] })).status, 400)
  assert.equal((await post(ang.token, { convo_id: 'c1', refs: [] })).status, 400)
  assert.equal((await post(ang.token, { convo_id: 'b1', refs: [`msg:b1:1`] })).status, 404)
  // An ordinary Coordinator can't flag (or probe) private conversations.
  assert.equal((await post(bev.token, { convo_id: 'coord', refs: ['msg:pc:1'] })).status, 404)
})

test('ws seen / item_seen: clients only; ranges stored; read_marker is the legacy fallback until then', async (t) => {
  const { s, dan, ang, client, say } = await fleet(t)
  const a = say('c1', 'one', 'agent:ang')
  const ws = await makeWsClient(s.base, { token: client, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  // Legacy: this device hasn't sent `seen` yet, so its read marker counts.
  ws.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: a })
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  assert.deepEqual(seenRanges(s.db, dan.id, 'c1'), [[1, a]])
  const b = say('c1', 'two', 'agent:ang')
  const c = say('c1', 'three', 'agent:ang')
  ws.send({ op: 'seen', convo_id: 'c1', ranges: [[c, c]] })
  ws.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: c }) // no longer counts
  await ws.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker' && f.payload.up_to_seq === c)
  assert.deepEqual(seenRanges(s.db, dan.id, 'c1'), [[1, a], [c, c]])
  assert.ok(b > a)
  ws.send({ op: 'seen', convo_id: 'c1', ranges: [[0, 1]] })
  await ws.waitFor((f) => f.op === 'error' && f.ref === 'seen' && f.code === 'bad_request')
  ws.send({ op: 'seen', convo_id: 'p1', ranges: [[1, 1]] })
  await ws.waitFor((f) => f.op === 'error' && f.ref === 'seen' && f.code === 'forbidden')
  const { item } = createItem(s.db, { userId: dan.id, kind: 'question', title: 'Q', awaiting: 'user', originConvoId: 'c1', originDeviceId: ang.deviceId, createdBy: 'agent' })
  ws.send({ op: 'item_seen', item_id: item.id, through_comment_at: 0 })
  ws.send({ op: 'item_seen', item_id: 'it_nope' })
  await ws.waitFor((f) => f.op === 'error' && f.ref === 'item_seen' && f.code === 'forbidden')
  assert.ok(s.db.prepare('SELECT 1 FROM item_seen WHERE item_id=?').get(item.id))
  ws.close()
  // An agent can't report seen.
  const aw = await makeWsClient(s.base, { token: ang.token, cursor: null })
  await aw.waitFor((f) => f.op === 'hello_ok')
  aw.send({ op: 'seen', convo_id: 'c1', ranges: [[1, 1]] })
  await aw.waitFor((f) => f.op === 'error' && f.ref === 'seen' && f.code === 'forbidden')
  // A bridge's read marker never counts as seen.
  const before = seenRanges(s.db, dan.id, 'c1')
  aw.send({ op: 'read_marker', convo_id: 'c1', up_to_seq: null })
  await aw.waitFor((f) => f.kind === 'journal' && f.type === 'read_marker')
  assert.deepEqual(seenRanges(s.db, dan.id, 'c1'), before)
  aw.close()
})
