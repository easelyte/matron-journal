import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { sharePreview } from '../src/grants.js'
import { handoverPreview } from '../src/handover.js'

// Owner-only items (`private`, db.js): what a bridge files for the user
// alone — a secure-input request whose body carries the live form link, a
// foreign "Allow once" ask — stays with the owner however the mission is
// shared. A grantee never lists, reads, looks up or writes to one; a
// hand-over never copies one; the share card never counts one. To the
// owner's own devices it is an ordinary item.
const post = (body) => ({ method: 'POST', body })

async function world(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw')
  const bob = await createUser(s.db, 'bob', 'pw')
  const aliceBox = createAgent(s.db, alice.id, 'alice-box')
  const bobBox = createAgent(s.db, bob.id, 'bob-box')
  upsertConversation(s.db, { id: 'work', ownerUserId: alice.id, title: 'Garden Club', agentDeviceId: aliceBox.deviceId })
  upsertConversation(s.db, { id: 'bobwork', ownerUserId: bob.id, title: 'Bob', agentDeviceId: bobBox.deviceId })
  const login = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: `${name}-phone` } })).json.token
  const tokens = { alicePhone: await login('alice'), bobPhone: await login('bob'), aliceBox: aliceBox.token, bobBox: bobBox.token }
  const http = (token) => (p, opts = {}) => s.http(p, { token, ...opts })
  return { s, alice, bob, aliceBox: http(tokens.aliceBox), bobBox: http(tokens.bobBox), alicePhone: http(tokens.alicePhone), bobPhone: http(tokens.bobPhone) }
}

async function makeContacts(w) {
  await w.alicePhone('/contacts', post({ user: 'bob' }))
  const theirs = (await w.bobPhone('/contacts')).json.contacts[0]
  assert.equal((await w.bobPhone(`/contacts/${theirs.id}/answer`, post({ decision: 'approve' }))).status, 200)
}

// alice's mission with one ordinary and one owner-only item, shared with
// bob at `level`.
async function shared(w, level) {
  const m = (await w.aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club launch' }))).json.mission
  const plain = (await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Which caterer?' }))).json.item
  const r = await w.aliceBox('/items', post({ convo_id: 'work', kind: 'question', title: 'Secret needed: the caterer API key', body: 'Enter it at https://viewer.example/secret?token=abc', private: true, actions: ['Done'] }))
  assert.equal(r.status, 201)
  const secret = r.json.item
  assert.equal(secret.private, true)
  assert.equal(secret.mission_id, m.id, 'on the mission like any other item')
  assert.equal(plain.private, false)
  await makeContacts(w)
  const g = await w.alicePhone(`/missions/${m.id}/shares`, post({ contact: 'bob', level }))
  assert.equal(g.status, 201)
  assert.equal((await w.bobPhone(`/grants/${g.json.grant.id}/answer`, post({ decision: 'approve' }))).json.grant.level, level)
  return { m, plain, secret, gid: g.json.grant.id }
}

test('POST /items: private must be a boolean', async (t) => {
  const w = await world(t)
  assert.equal((await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'x', private: 'yes' }))).status, 400)
  assert.equal((await w.aliceBox('/items', post({ convo_id: 'work', kind: 'task', title: 'x', private: false }))).json.item.private, false)
})

test('an owner-only item never reaches a read grantee', async (t) => {
  const w = await world(t)
  const { m, plain, secret } = await shared(w, 'read')
  for (const who of [w.bobPhone, w.bobBox]) {
    const listed = (await who('/items?scope=shared')).json.items.map((i) => i.id)
    assert.deepEqual(listed, [plain.id])
    assert.equal((await who(`/items/${secret.id}`)).status, 404)
    assert.equal((await who(`/items/${plain.id}`)).status, 200)
    assert.equal((await who(`/lookup?user=alice&num=${secret.num}`)).status, 404)
    assert.equal((await who(`/lookup?user=alice&num=${plain.num}`)).status, 200)
    const detail = (await who(`/missions/${m.id}`)).json
    assert.deepEqual(detail.items.map((i) => i.id), [plain.id])
    assert.equal(detail.mission.open_items, 1)
  }
  // The share card counted only what crosses.
  assert.equal(sharePreview(w.s.db, m.id).items, 1)
  assert.equal(handoverPreview(w.s.db, { kind: 'mission', id: m.id, ownerUserId: w.alice.id }).items, 1)
  // The owner's own devices see an ordinary item and can settle it.
  const mine = (await w.aliceBox(`/items/${secret.id}`)).json
  assert.equal(mine.item.private, true)
  assert.deepEqual(mine.item.actions, ['Done'])
  assert.equal((await w.alicePhone('/items')).json.items.filter((i) => i.id === secret.id).length, 1)
  assert.equal((await w.aliceBox(`/items/${secret.id}/close`, post({ resolution: 'answered' }))).status, 200)
})

test('a contributor neither reads nor writes an owner-only item', async (t) => {
  const w = await world(t)
  const { plain, secret } = await shared(w, 'contribute')
  assert.equal((await w.bobBox(`/items/${secret.id}`)).status, 404)
  assert.equal((await w.bobBox(`/items/${secret.id}/comments`, post({ body: 'I will do it', convo_id: 'bobwork' }))).status, 404)
  assert.equal((await w.bobBox(`/items/${secret.id}/close`, post({ resolution: 'done' }))).status, 404)
  assert.equal((await w.bobBox(`/items/${secret.id}/reopen`, post({}))).status, 404)
  assert.equal((await w.bobPhone(`/items/${secret.id}/comments`, post({ action: 'Done' }))).status, 404)
  // A contributor cannot file one into the owner's mission (nor make a
  // non-private one by naming the flag).
  const m = (await w.aliceBox(`/items/${plain.id}`)).json.item.mission_id
  assert.equal((await w.bobBox('/items', post({ mission: m, kind: 'task', title: 'mine', private: true, convo_id: 'bobwork' }))).status, 400)
  assert.equal((await w.bobBox('/items', post({ mission: m, kind: 'task', title: 'mine', private: false, convo_id: 'bobwork' }))).status, 400)
  assert.equal((await w.bobBox('/items', post({ mission: m, kind: 'task', title: 'mine', convo_id: 'bobwork' }))).status, 201)
  // The ordinary item is still theirs to comment on.
  assert.equal((await w.bobBox(`/items/${plain.id}/comments`, post({ body: 'The second one.', convo_id: 'bobwork' }))).status, 201)
  // Nothing the owner does on the owner-only item is announced to the grantee's side.
  assert.equal((await w.aliceBox(`/items/${secret.id}/comments`, post({ body: 'noted' }))).status, 201)
  assert.equal((await w.bobBox(`/items/${secret.id}`)).status, 404)
})
