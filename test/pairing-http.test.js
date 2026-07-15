import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'
import { makePairStore } from '../src/pairing.js'

async function loggedInClient(s, username = 'dan', password = 'hunter22') {
  await createUser(s.db, username, password)
  const login = await s.http('/login', { method: 'POST', body: { username, password, device_name: 'phone' } })
  return login.json
}

test('happy path: start → approve → claim mints the device at claim; token works over ws', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)

  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(start.status, 200)
  assert.match(start.json.pair_code, /^[0-9BCDFGHJKMNPQRSTVWXYZ]{4}-[0-9BCDFGHJKMNPQRSTVWXYZ]{4}$/)
  assert.match(start.json.poll_token, /^[0-9a-f]{64}$/)
  assert.equal(start.json.expires_in, 600)

  // pending before approve; and crucially NO device row exists yet
  const pending = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.deepEqual(pending.json, { status: 'pending' })
  let roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // just the phone

  const approve = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  assert.equal(approve.status, 200)
  assert.deepEqual(approve.json, { status: 'approved' })
  // still no device row: mint happens at claim, not approve
  roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1)

  const claim = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.equal(claim.status, 200)
  assert.equal(claim.json.status, 'approved')
  assert.match(claim.json.token, /^[0-9a-f]{64}$/)
  assert.ok(Number.isInteger(claim.json.device_id))

  // exactly once: second claim is 404
  const again = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.equal(again.status, 404)

  // the minted device is a real agent of the approving user…
  roster = await s.http('/devices', { token: me.token })
  const minted = roster.json.devices.find((d) => d.device_id === claim.json.device_id)
  assert.equal(minted.kind, 'agent')
  assert.equal(minted.name, 'dev-9')
  // …and its token authenticates over ws like any agent
  const ws = await makeWsClient(s.base, { token: claim.json.token, cursor: null })
  await ws.waitFor((f) => f.op === 'hello_ok')
  ws.close()
})

test('double-approve is 409; exactly one device row after the eventual claim', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  const a1 = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  assert.equal(a1.status, 200)
  const a2 = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'other' } })
  assert.equal(a2.status, 409)
  assert.deepEqual(a2.json, { error: 'conflict' })
  await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.filter((d) => d.kind === 'agent').length, 1)
  assert.equal(roster.json.devices.find((d) => d.kind === 'agent').name, 'dev-9')
})

test('expired approved-but-unclaimed pair leaves zero DB residue', async (t) => {
  const s = await startTestServer({ pairs: makePairStore({ ttlMs: 30 }) })
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  await new Promise((r) => setTimeout(r, 60))
  const claim = await s.http('/pair/claim', { method: 'POST', body: { poll_token: start.json.poll_token } })
  assert.equal(claim.status, 404)
  const roster = await s.http('/devices', { token: me.token })
  assert.equal(roster.json.devices.length, 1) // no orphan agent row, ever
})

test('gating and validation: approve needs a client bearer; bad bodies 400; unknown code 404', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const agent = createAgent(s.db, 1, 'existing-agent')

  const asAgent = await s.http('/pair/approve', { method: 'POST', token: agent.token, body: { pair_code: 'XXXX-XXXX', agent_name: 'x' } })
  assert.equal(asAgent.status, 403)
  assert.equal((await s.http('/pair/approve', { method: 'POST', body: { pair_code: 'XXXX-XXXX', agent_name: 'x' } })).status, 401)

  for (const body of [{}, { pair_code: 'ABCD-1234' }, { agent_name: 'x' }, { pair_code: 7, agent_name: 'x' }, { pair_code: 'ABCD-1234', agent_name: '' }]) {
    const r = await s.http('/pair/approve', { method: 'POST', token: me.token, body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'bad_request' })
  }
  const unknown = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: 'XXXX-XXXX', agent_name: 'x' } })
  assert.equal(unknown.status, 404)

  for (const body of [{}, { poll_token: 7 }, { poll_token: '' }]) {
    const r = await s.http('/pair/claim', { method: 'POST', body })
    assert.equal(r.status, 400, JSON.stringify(body))
  }
  assert.equal((await s.http('/pair/claim', { method: 'POST', body: { poll_token: 'f'.repeat(64) } })).status, 404)
})

test('pair/preview: the approval screen sees the requester IP and remaining TTL for a pending pair', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)

  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(start.status, 200)

  // start recorded the test client's IP on the pending pair
  const v = await s.http('/pair/preview', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code } })
  assert.equal(v.status, 200)
  assert.equal(typeof v.json.requester_ip, 'string')
  assert.ok(v.json.requester_ip.length > 0)
  assert.ok(v.json.expires_in > 0 && v.json.expires_in <= 600)

  // sloppy human-typed code (lowercase, no hyphen) previews the same pair
  const sloppy = await s.http('/pair/preview', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code.toLowerCase().replace('-', '') } })
  assert.equal(sloppy.status, 200)
  assert.equal(sloppy.json.requester_ip, v.json.requester_ip)

  // preview mutated nothing: the pair is still approvable
  const approve = await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  assert.equal(approve.status, 200)
})

test('pair/preview gating and validation: client bearer only; bad bodies 400; unknown and approved codes 404', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const me = await loggedInClient(s)
  const agent = createAgent(s.db, 1, 'existing-agent')

  assert.equal((await s.http('/pair/preview', { method: 'POST', body: { pair_code: 'XXXX-XXXX' } })).status, 401)
  const asAgent = await s.http('/pair/preview', { method: 'POST', token: agent.token, body: { pair_code: 'XXXX-XXXX' } })
  assert.equal(asAgent.status, 403)

  for (const body of [{}, { pair_code: 7 }, { pair_code: '' }]) {
    const r = await s.http('/pair/preview', { method: 'POST', token: me.token, body })
    assert.equal(r.status, 400, JSON.stringify(body))
    assert.deepEqual(r.json, { error: 'bad_request' })
  }

  const unknown = await s.http('/pair/preview', { method: 'POST', token: me.token, body: { pair_code: 'XXXX-XXXX' } })
  assert.equal(unknown.status, 404)

  // already-approved merges into the same 404: nothing left to preview
  const start = await s.http('/pair/start', { method: 'POST', body: {} })
  await s.http('/pair/approve', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code, agent_name: 'dev-9' } })
  const approved = await s.http('/pair/preview', { method: 'POST', token: me.token, body: { pair_code: start.json.pair_code } })
  assert.equal(approved.status, 404)
})

test('pair/start is rate-limited per IP (shared /login budget) and capped by the store', async (t) => {
  // rateLimiter default: 5/min per IP. All test-client requests share 127.0.0.1.
  const s = await startTestServer({ pairs: makePairStore({ maxPending: 2 }) })
  t.after(() => s.close())
  const r1 = await s.http('/pair/start', { method: 'POST', body: {} })
  const r2 = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(r1.status, 200)
  assert.equal(r2.status, 200)
  // 3rd within the IP budget but over the store cap → 429 from the cap
  const r3 = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(r3.status, 429)
  assert.deepEqual(r3.json, { error: 'rate_limited' })
  // 4th and 5th burn the remaining IP budget; 6th is the limiter's 429
  await s.http('/pair/start', { method: 'POST', body: {} })
  await s.http('/pair/start', { method: 'POST', body: {} })
  const r6 = await s.http('/pair/start', { method: 'POST', body: {} })
  assert.equal(r6.status, 429)
})
