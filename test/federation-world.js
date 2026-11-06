import assert from 'node:assert/strict'
import { createUser, createAgent } from '../src/auth.js'
import { makeFederationClient } from '../src/federation-client.js'
import { startTestServer } from './helpers.js'
import { upsertConversation } from '../src/journal.js'

// Two journals on loopback for the share tests: alice on a.example and bob
// on b.example, contacts by invite link, and alice's mission to share.
export const KEY = 'd'.repeat(64)
export const post = (body) => ({ method: 'POST', body })

export async function world(t) {
  const bases = {}
  const client = makeFederationClient({
    allowHttp: true, allowHosts: ['127.0.0.1'],
    rewriteUrl: (u) => { const x = new URL(u); return bases[x.host] ? bases[x.host] + x.pathname + x.search : u },
  })
  const start = async (host) => {
    const s = await startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: `https://${host}` }, federationClient: client })
    t.after(() => s.close())
    bases[host] = s.base
    return s
  }
  const a = await start('a.example')
  const b = await start('b.example')
  const users = {}
  const phones = {}
  for (const [s, name] of [[a, 'alice'], [b, 'bob']]) {
    users[name] = await createUser(s.db, name, 'pw')
    const token = (await s.http('/login', post({ username: name, password: 'pw', device_name: `${name}-phone` }))).json.token
    phones[name] = (path, opts = {}) => s.http(path, { token, ...opts })
  }
  const box = createAgent(a.db, users.alice.id, 'alice-box')
  upsertConversation(a.db, { id: 'work', ownerUserId: users.alice.id, title: 'Work', agentDeviceId: box.deviceId })
  const aliceBox = (path, opts = {}) => a.http(path, { token: box.token, ...opts })
  const settle = async () => {
    for (let i = 0; i < 10; i++) {
      await a.federationOutbox.tick()
      await b.federationOutbox.tick()
      const live = (s) => s.db.prepare("SELECT COUNT(*) AS n FROM fed_outbox WHERE state='queued' AND next_at<=?").get(Date.now()).n
      if (!live(a) && !live(b)) return
    }
  }
  // Contacts, by invite link.
  const { link } = (await phones.alice('/contacts/invites', post({}))).json
  assert.equal((await phones.bob('/contacts/invites/accept', post({ link }))).status, 202)
  await settle()
  const m = await aliceBox('/missions', post({ convo_id: 'work', title: 'Garden Club', body: 'Spring planting.' }))
  assert.equal(m.status, 201)
  return { a, b, users, phones, aliceBox, settle, mission: m.json.mission }
}

export const grantOf = (s, id) => s.db.prepare('SELECT * FROM grants WHERE id=?').get(id)
export const incoming = (s) => s.db.prepare('SELECT * FROM fed_grants_in').all()
export const mirrorOf = (s, userId) => s.db.prepare("SELECT * FROM items WHERE user_id=? AND consent='share' ORDER BY rowid DESC").get(userId)
export const audits = (s, userId) => s.db.prepare("SELECT json_extract(payload, '$.event') AS e, json_extract(payload, '$.summary') AS summary FROM events WHERE user_id=? AND type='people' ORDER BY seq").all(userId)
  .filter((r) => r.e.startsWith('grant.'))
export const notices = (s, userId) => s.db.prepare("SELECT title, body FROM items WHERE user_id=? AND kind='notice' ORDER BY rowid").all(userId)

export async function offer(w) {
  const r = await w.phones.alice(`/missions/${w.mission.id}/shares`, post({ contact: 'bob@b.example', level: 'read' }))
  assert.equal(r.status, 201, JSON.stringify(r.json))
  await w.settle()
  return r.json.grant
}
