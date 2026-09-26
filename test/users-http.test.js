import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { startTestServer } from './helpers.js'
import { createUser, createAgent, login } from '../src/auth.js'
import { saveGithubIdentity, githubAccountView } from '../src/github-accounts.js'

async function fleet(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const root = await createUser(s.db, 'root', 'pw123456')
  const dan = await createUser(s.db, 'dan', 'pw123456')
  s.db.prepare('UPDATE users SET is_admin=1 WHERE id=?').run(root.id)
  const rootAgent = createAgent(s.db, root.id, 'root-box')
  const tok = async (name) => (await s.http('/login', { method: 'POST', body: { username: name, password: 'pw123456', device_name: 'mac' } })).json.token
  return { s, root, dan, rootAgent, rootTok: await tok('root'), danTok: await tok('dan') }
}

test('users admin: every route is 403 for a non-admin client and for an admin\'s own agent, and says nothing about ids (review focus 1)', async (t) => {
  const { s, dan, rootAgent, danTok } = await fleet(t)
  const calls = [
    ['/users', 'GET'], ['/users', 'POST', { name: 'x', password: 'pw123456' }],
    [`/users/${dan.id}`, 'PATCH', { is_admin: true }], ['/users/999', 'PATCH', { is_admin: true }],
    [`/users/${dan.id}/password`, 'POST', { password: 'pw123456' }],
    [`/users/${dan.id}/github-link`, 'DELETE'], [`/users/${dan.id}/link-code`, 'POST', {}],
  ]
  for (const token of [danTok, rootAgent.token]) {
    for (const [path, method, body] of calls) {
      const r = await s.http(path, { method, token, body })
      assert.equal(r.status, 403, `${method} ${path} for ${token === danTok ? 'non-admin' : 'agent'}`)
      assert.deepEqual(r.json, { error: 'forbidden' })
    }
  }
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 2)
})

test('users admin: list, create (validated, 409 on a taken name), reset password, flip admin, last-admin guard (review focus 2)', async (t) => {
  const { s, root, dan, rootTok } = await fleet(t)
  saveGithubIdentity(s.db, { userId: dan.id, host: 'github.com', identity: { github_id: 5, login: 'DanB', scopes: [] }, token: 'tok', now: 1 })
  const list = await s.http('/users', { token: rootTok })
  assert.equal(list.status, 200)
  assert.deepEqual(list.json.users.map((u) => [u.name, u.is_admin, u.github && u.github.login]), [['root', true, null], ['dan', false, 'DanB']])
  assert.ok(!JSON.stringify(list.json).includes('tok'), 'no token in the listing')
  assert.ok(!JSON.stringify(list.json).includes('password'), 'no hash in the listing')

  const made = await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'pat', password: 'pw123456' } })
  assert.equal(made.status, 201)
  assert.deepEqual({ name: made.json.user.name, is_admin: made.json.user.is_admin, github: made.json.user.github }, { name: 'pat', is_admin: false, github: null })
  assert.ok((await login(s.db, { username: 'pat', password: 'pw123456', deviceName: 'ph' })).token, 'the new user can sign in')
  assert.equal((await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'pat', password: 'pw123456' } })).status, 409)
  assert.equal((await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'bad name', password: 'pw123456' } })).status, 400)
  assert.equal((await s.http('/users', { method: 'POST', token: rootTok, body: { name: '../x', password: 'pw123456' } })).status, 400)
  const weak = await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'sam', password: 'short' } })
  assert.equal(weak.status, 400); assert.equal(weak.json.error, 'weak_password')
  const admin2 = await s.http('/users', { method: 'POST', token: rootTok, body: { name: 'sam', password: 'pw123456', is_admin: true } })
  assert.equal(admin2.json.user.is_admin, true)

  assert.equal((await s.http(`/users/${dan.id}/password`, { method: 'POST', token: rootTok, body: { password: 'newpw12345' } })).status, 200)
  assert.ok((await login(s.db, { username: 'dan', password: 'newpw12345', deviceName: 'ph' })).token)
  assert.equal((await s.http(`/users/${dan.id}/password`, { method: 'POST', token: rootTok, body: { password: 'short' } })).json.error, 'weak_password')
  assert.equal((await s.http('/users/999/password', { method: 'POST', token: rootTok, body: { password: 'newpw12345' } })).status, 404)

  const promoted = await s.http(`/users/${dan.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: true } })
  assert.equal(promoted.status, 200); assert.equal(promoted.json.user.is_admin, true)
  assert.equal((await s.http(`/users/${dan.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: 'yes' } })).status, 400)
  // root, dan, sam are admins now; demote two, then the last one is refused.
  assert.equal((await s.http(`/users/${dan.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: false } })).status, 200)
  assert.equal((await s.http(`/users/${admin2.json.user.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: false } })).status, 200)
  const last = await s.http(`/users/${root.id}`, { method: 'PATCH', token: rootTok, body: { is_admin: false } })
  assert.equal(last.status, 409); assert.equal(last.json.reason, 'last_admin')
  assert.equal(s.db.prepare('SELECT is_admin FROM users WHERE id=?').get(root.id).is_admin, 1)
  assert.equal((await s.http('/users/999', { method: 'PATCH', token: rootTok, body: { is_admin: true } })).status, 404)
})

test('users admin: clearing a GitHub link and minting a link code', async (t) => {
  const { s, dan, rootTok } = await fleet(t)
  assert.equal((await s.http(`/users/${dan.id}/github-link`, { method: 'DELETE', token: rootTok })).status, 404, 'nothing linked yet')
  saveGithubIdentity(s.db, { userId: dan.id, host: 'github.com', identity: { github_id: 5, login: 'DanB', scopes: ['github.com/matronhq'] }, token: 'tok', now: 1 })
  assert.deepEqual((await s.http(`/users/${dan.id}/github-link`, { method: 'DELETE', token: rootTok })).json, { ok: true })
  assert.equal(githubAccountView(s.db, dan.id), null)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM github_orgs WHERE user_id=?').get(dan.id).n, 0)

  const code = await s.http(`/users/${dan.id}/link-code`, { method: 'POST', token: rootTok, body: {} })
  assert.equal(code.status, 200)
  assert.match(code.json.link_code, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/)
  assert.equal(code.json.expires_in, 600)
  const short = await s.http(`/users/${dan.id}/link-code`, { method: 'POST', token: rootTok, body: { ttl_seconds: 120 } })
  assert.equal(short.json.expires_in, 120)
  // The minted code signs a device in as dan, no approval tap.
  const claim = await s.http('/link/claim', { method: 'POST', body: { link_code: short.json.link_code, device_name: 'dans phone' } })
  assert.equal(claim.status, 200)
  const poll = await s.http('/link/poll', { method: 'POST', body: { claim_token: claim.json.claim_token } })
  assert.equal(poll.json.status, 'approved')
  assert.equal(s.db.prepare("SELECT user_id FROM devices WHERE name='dans phone'").get().user_id, dan.id)
  for (const bad of [{ ttl_seconds: 30 }, { ttl_seconds: 90000 }, { ttl_seconds: '120' }]) {
    assert.equal((await s.http(`/users/${dan.id}/link-code`, { method: 'POST', token: rootTok, body: bad })).status, 400)
  }
  assert.equal((await s.http('/users/999/link-code', { method: 'POST', token: rootTok, body: {} })).status, 404)
})

// A slow POST /users body is a window: readBody() awaits the whole body
// before the handler does anything else, so an admin's rights can be
// revoked (demotion, or the device itself dropped) while bytes are still
// arriving. The route must re-check after the await, not just before it.
function slowPost(s, token, body, mutateMidBody) {
  return new Promise((resolve, reject) => {
    const req = http.request(s.base + '/users', {
      method: 'POST', agent: false,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = ''
      res.on('data', (c) => { data += c })
      res.on('end', () => resolve({ status: res.statusCode, json: data ? JSON.parse(data) : null }))
    })
    req.on('error', reject)
    const half = Math.floor(body.length / 2)
    req.write(body.slice(0, half))
    setTimeout(() => {
      mutateMidBody()
      req.end(body.slice(half))
    }, 50)
  })
}

test('users admin: a demotion during a slow body upload is honoured', async (t) => {
  const { s, root, rootTok } = await fleet(t)
  const body = JSON.stringify({ name: 'slowdemote', password: 'pw123456' })
  const r = await slowPost(s, rootTok, body, () => {
    s.db.prepare('UPDATE users SET is_admin=0 WHERE id=?').run(root.id)
  })
  assert.equal(r.status, 403)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users WHERE name=?').get('slowdemote').n, 0)
})

test('users admin: a device revocation during a slow body upload is honoured', async (t) => {
  const { s, root, rootTok } = await fleet(t)
  const before = s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n
  const deviceId = s.db.prepare("SELECT id FROM devices WHERE user_id=? AND kind='client'").get(root.id).id
  const body = JSON.stringify({ name: 'slowrevoke', password: 'pw123456' })
  const r = await slowPost(s, rootTok, body, () => {
    s.db.prepare('DELETE FROM devices WHERE id=?').run(deviceId)
  })
  assert.ok(r.status === 403 || r.status === 401, `expected 403 or 401, got ${r.status}`)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, before)
})

test('users admin: concurrent creates of one name: one 201, one 409', async (t) => {
  const { s, rootTok } = await fleet(t)
  const post = () => s.http('/users', { method: 'POST', token: rootTok, body: { name: 'race', password: 'pw123456' } })
  const [r1, r2] = await Promise.all([post(), post()])
  assert.deepEqual([r1.status, r2.status].sort(), [201, 409])
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM users WHERE name=?').get('race').n, 1)
})
