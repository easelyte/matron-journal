import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { upsertConversation } from '../src/journal.js'
import { saveGithubIdentity } from '../src/github-accounts.js'

test('/lookup resolves a per-user number to item, mission or milestone under the same visibility as the reads', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw'); const pat = await createUser(s.db, 'pat', 'pw'); const sam = await createUser(s.db, 'sam', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  for (const [u, gid] of [[dan, 1], [pat, 2]]) saveGithubIdentity(s.db, { userId: u.id, host: 'github.com', identity: { github_id: gid, login: u.name, scopes: ['github.com/matronhq'] }, token: `t${gid}`, now: 1 })
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id, title: 'C1', agentDeviceId: ag.deviceId, repo: 'github.com/matronhq/x' })
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw', device_name: 'mac' } })).json.token
  const danTok = await tok('dan'); const patTok = await tok('pat'); const samTok = await tok('sam')
  // One per-user counter numbers all three kinds, so these are #1, #2, #3.
  const item = (await s.http('/items', { method: 'POST', token: ag.token, body: { kind: 'task', title: 'T', convo_id: 'c1' } })).json.item
  const mission = (await s.http('/missions', { method: 'POST', token: ag.token, body: { convo_id: 'c1', title: 'M' } })).json.mission
  const ms = (await s.http('/milestones', { method: 'POST', token: ag.token, body: { convo_id: 'c1', kind: 'progress', title: 'S' } })).json.milestone
  const look = (token, user, num) => s.http(`/lookup?user=${user}&num=${num}`, { token })
  assert.deepEqual((await look(danTok, 'dan', 1)).json, { kind: 'item', id: item.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.deepEqual((await look(danTok, 'dan', 2)).json, { kind: 'mission', id: mission.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.deepEqual((await look(danTok, 'dan', 3)).json, { kind: 'milestone', id: ms.id, owner: { user_id: dan.id, name: 'dan' } })
  assert.equal((await look(patTok, 'dan', 1)).json.kind, 'item', 'colleague in the org')
  assert.equal((await look(patTok, 'dan', 3)).json.kind, 'milestone')
  assert.equal((await look(samTok, 'dan', 1)).status, 404, 'no link')
  assert.equal((await look(danTok, 'dan', 99)).status, 404)
  assert.equal((await look(danTok, 'nobody', 1)).status, 404, 'unknown user is the same 404')
  assert.equal((await look(danTok, 'dan', 'x')).status, 400)
  assert.equal((await s.http('/lookup?user=dan', { token: danTok })).status, 400)
  // Link-shaped path with a JSON Accept header resolves the same way.
  const r = await fetch(`${s.base}/u/dan/1`, { headers: { authorization: `Bearer ${patTok}`, accept: 'application/json' } })
  assert.equal(r.status, 200); assert.equal((await r.json()).kind, 'item')
})
