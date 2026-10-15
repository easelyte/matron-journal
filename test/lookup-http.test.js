import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { saveGithubIdentity } from '../src/github-accounts.js'

test('/lookup resolves a per-user number to item, mission or milestone under the same visibility as the reads', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const alice = await createUser(s.db, 'alice', 'pw'); const pat = await createUser(s.db, 'pat', 'pw'); const sam = await createUser(s.db, 'sam', 'pw')
  const ag = createAgent(s.db, alice.id, 'box-2')
  for (const [u, gid] of [[alice, 1], [pat, 2]]) saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  upsertConversation(s.db, { id: 'c1', ownerUserId: alice.id, title: 'C1', agentDeviceId: ag.deviceId, repo: 'github.com/matronhq/x' })
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'mac' } })).json.token
  const aliceTok = await tok('alice'); const patTok = await tok('pat'); const samTok = await tok('sam')
  // One per-user counter numbers every kind (a mission's own project takes
  // a number too), so each row is looked up by the number it was given.
  const item = (await s.http('/items', { method: 'POST', token: ag.token, body: { kind: 'task', title: 'T', convo_id: 'c1' } })).json.item
  const mission = (await s.http('/missions', { method: 'POST', token: ag.token, body: { convo_id: 'c1', title: 'M' } })).json.mission
  const ms = (await s.http('/milestones', { method: 'POST', token: ag.token, body: { convo_id: 'c1', kind: 'progress', title: 'S' } })).json.milestone
  const look = (token, user, num) => s.http(`/lookup?user=${user}&num=${num}`, { token })
  assert.deepEqual((await look(aliceTok, 'alice', item.num)).json, { kind: 'item', id: item.id, num: item.num, title: 'T', owner: { user_id: alice.id, name: 'alice' } })
  assert.deepEqual((await look(aliceTok, 'alice', mission.num)).json, { kind: 'mission', id: mission.id, num: mission.num, title: 'M', owner: { user_id: alice.id, name: 'alice' } })
  assert.deepEqual((await look(aliceTok, 'alice', ms.num)).json, { kind: 'milestone', id: ms.id, num: ms.num, title: 'S', mission: { id: mission.id, num: mission.num }, owner: { user_id: alice.id, name: 'alice' } })
  assert.equal((await look(patTok, 'alice', 1)).json.kind, 'item', 'colleague in the org')
  assert.equal((await look(patTok, 'alice', ms.num)).json.kind, 'milestone')
  assert.deepEqual((await look(patTok, 'alice', ms.num)).json.mission, { id: mission.id, num: mission.num }, 'a colleague who can read the mission is told it too')
  assert.equal((await look(samTok, 'alice', 1)).status, 404, 'no link')
  assert.equal((await look(aliceTok, 'alice', 99)).status, 404)
  assert.equal((await look(aliceTok, 'nobody', 1)).status, 404, 'unknown user is the same 404')
  assert.equal((await look(aliceTok, 'alice', 'x')).status, 400)
  assert.equal((await s.http('/lookup?user=alice', { token: aliceTok })).status, 400)
  // Link-shaped path with a JSON Accept header resolves the same way.
  const r = await fetch(`${s.base}/u/alice/1`, { headers: { authorization: `Bearer ${patTok}`, accept: 'application/json' } })
  assert.equal(r.status, 200); assert.equal((await r.json()).kind, 'item')
})
