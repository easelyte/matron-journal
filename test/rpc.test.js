import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser, createAgent } from '../src/auth.js'

// Shared fixture: user dan with one agent device (dev-2) and one logged-in
// client (mac). RPC needs both ends, so most tests open both sockets.
async function setup(t) {
  const s = await startTestServer()
  t.after(() => s.close())
  const dan = await createUser(s.db, 'dan', 'pw')
  const ag = createAgent(s.db, dan.id, 'dev-2')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'mac' } })
  return { s, dan, ag, login }
}

async function open(s, token) {
  const c = await makeWsClient(s.base, { token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  return c
}

test('agent_request reaches the agent with stamped from_device_id and opaque params', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agent = await open(s, ag.token)
  client.send({
    op: 'agent_request', request_id: 'r1', agent_device_id: ag.deviceId,
    method: 'recent_folders', params: { anything: ['goes', 42] },
  })
  const f = await agent.waitFor((x) => x.kind === 'rpc')
  assert.deepEqual(f, {
    kind: 'rpc',
    request: {
      request_id: 'r1', from_device_id: login.json.device_id,
      method: 'recent_folders', params: { anything: ['goes', 42] },
    },
  })
})

test('omitted params forwards as null', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agent = await open(s, ag.token)
  client.send({ op: 'agent_request', request_id: 'r2', agent_device_id: ag.deviceId, method: 'start' })
  const f = await agent.waitFor((x) => x.kind === 'rpc')
  assert.equal(f.request.params, null)
})

test('offline agent -> agent_unreachable carrying request_id', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  // agent socket never opened
  client.send({ op: 'agent_request', request_id: 'r3', agent_device_id: ag.deviceId, method: 'start' })
  const err = await client.waitFor((f) => f.op === 'error')
  assert.equal(err.code, 'agent_unreachable')
  assert.equal(err.request_id, 'r3')
  assert.equal(err.ref, 'agent_request')
})

test('unknown, other-user, and client-kind targets are indistinguishable not_found', async (t) => {
  const { s, login } = await setup(t)
  const pat = await createUser(s.db, 'pat', 'password')
  const patAgent = createAgent(s.db, pat.id, 'pat-box')
  const client = await open(s, login.json.token)
  for (const target of [99999, patAgent.deviceId, login.json.device_id]) {
    client.frames.length = 0
    client.send({ op: 'agent_request', request_id: 'r4', agent_device_id: target, method: 'start' })
    const err = await client.waitFor((f) => f.op === 'error')
    assert.equal(err.code, 'not_found')
    assert.equal(err.request_id, 'r4')
  }
})

test('agent connections cannot send agent_request', async (t) => {
  const { s, ag } = await setup(t)
  const agent = await open(s, ag.token)
  agent.send({ op: 'agent_request', request_id: 'r5', agent_device_id: ag.deviceId, method: 'x' })
  const err = await agent.waitFor((f) => f.op === 'error')
  assert.equal(err.code, 'forbidden')
})

test('malformed agent_request fields -> bad_request', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const bads = [
    { op: 'agent_request', agent_device_id: ag.deviceId, method: 'x' },                                  // missing request_id
    { op: 'agent_request', request_id: '', agent_device_id: ag.deviceId, method: 'x' },                  // empty request_id
    { op: 'agent_request', request_id: 'y'.repeat(129), agent_device_id: ag.deviceId, method: 'x' },     // long request_id
    { op: 'agent_request', request_id: 'r', agent_device_id: ag.deviceId },                              // missing method
    { op: 'agent_request', request_id: 'r', agent_device_id: ag.deviceId, method: 'm'.repeat(65) },      // long method
    { op: 'agent_request', request_id: 'r', agent_device_id: 'seven', method: 'x' },                     // non-integer device id
  ]
  for (const bad of bads) {
    client.frames.length = 0
    client.send(bad)
    const err = await client.waitFor((f) => f.op === 'error')
    assert.equal(err.code, 'bad_request')
  }
})

test('frame over 16 KiB -> bad_request', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agent = await open(s, ag.token)
  client.send({
    op: 'agent_request', request_id: 'big', agent_device_id: ag.deviceId,
    method: 'start', params: { pad: 'x'.repeat(17000) },
  })
  const err = await client.waitFor((f) => f.op === 'error')
  assert.equal(err.code, 'bad_request')
  assert.equal(err.request_id, 'big')
  // and nothing was forwarded
  assert.equal(agent.frames.filter((f) => f.kind === 'rpc').length, 0)
})

test('two live agent sockets: only the most recently registered receives the request', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agentOld = await open(s, ag.token)
  const agentNew = await open(s, ag.token)
  client.send({ op: 'agent_request', request_id: 'r6', agent_device_id: ag.deviceId, method: 'start' })
  const f = await agentNew.waitFor((x) => x.kind === 'rpc')
  assert.equal(f.request.request_id, 'r6')
  assert.equal(agentOld.frames.filter((x) => x.kind === 'rpc').length, 0)
})

test('agent_request before hub registration -> not_ready, nothing forwarded', async () => {
  // Unit-level: a mid-replay connection has conn.registered unset (ws.js
  // sets it only after hub.register). Deterministic here — an integration
  // test would have to race the replay loop.
  const { handleOp } = await import('../src/ws.js')
  const sent = []
  const conn = { kind: 'client', userId: 1, deviceId: 2, ws: { readyState: 1, send: (s) => sent.push(JSON.parse(s)) } }
  const hubCalls = []
  const hub = { sendRpcRequest: (...a) => { hubCalls.push(a); return true } }
  handleOp({ db: null, hub, conn, msg: { op: 'agent_request', request_id: 'nr1', agent_device_id: 3, method: 'start' } })
  assert.equal(sent.length, 1)
  assert.equal(sent[0].code, 'not_ready')
  assert.equal(sent[0].request_id, 'nr1')
  assert.equal(hubCalls.length, 0)
})

test('RPC traffic appends nothing to the journal', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agent = await open(s, ag.token)
  const before = await s.http('/metrics', { token: login.json.token })
  client.send({ op: 'agent_request', request_id: 'r7', agent_device_id: ag.deviceId, method: 'start' })
  await agent.waitFor((x) => x.kind === 'rpc')
  const after = await s.http('/metrics', { token: login.json.token })
  assert.equal(after.json.user.head_seq, before.json.user.head_seq)
  assert.equal(after.json.journal_row_count, before.json.journal_row_count)
})

test('full round-trip: response reaches the client with stamped agent_device_id', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agent = await open(s, ag.token)
  client.send({ op: 'agent_request', request_id: 'rt1', agent_device_id: ag.deviceId, method: 'recent_folders', params: {} })
  const req = await agent.waitFor((x) => x.kind === 'rpc')
  agent.send({
    op: 'agent_response', request_id: req.request.request_id,
    to_device_id: req.request.from_device_id, ok: true,
    result: { folders: [{ path: '/home/dan/yearbook-app', last_used: 1784500000000 }] },
  })
  const resp = await client.waitFor((x) => x.kind === 'rpc')
  assert.deepEqual(resp, {
    kind: 'rpc',
    response: {
      request_id: 'rt1', agent_device_id: ag.deviceId, ok: true,
      result: { folders: [{ path: '/home/dan/yearbook-app', last_used: 1784500000000 }] },
    },
  })
})

test('error responses require error.code and forward code+detail only', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agent = await open(s, ag.token)
  agent.send({
    op: 'agent_response', request_id: 'e1', to_device_id: login.json.device_id,
    ok: false, error: { code: 'bad_workdir', detail: 'no such directory', junk: 'stripped' },
  })
  const resp = await client.waitFor((x) => x.kind === 'rpc')
  assert.deepEqual(resp.response, {
    request_id: 'e1', agent_device_id: ag.deviceId, ok: false,
    error: { code: 'bad_workdir', detail: 'no such directory' },
  })
})

test('clients cannot send agent_response', async (t) => {
  const { s, login } = await setup(t)
  const client = await open(s, login.json.token)
  client.send({ op: 'agent_response', request_id: 'x', to_device_id: login.json.device_id, ok: true })
  const err = await client.waitFor((f) => f.op === 'error')
  assert.equal(err.code, 'forbidden')
})

test('agent_response to unknown, other-user, or agent-kind devices -> not_found', async (t) => {
  const { s, ag } = await setup(t)
  const pat = await createUser(s.db, 'pat', 'password')
  const patLogin = await s.http('/login', { method: 'POST', body: { username: 'pat', password: 'password', device_name: 'pat-phone' } })
  const agent = await open(s, ag.token)
  for (const target of [99999, patLogin.json.device_id, ag.deviceId]) {
    agent.frames.length = 0
    agent.send({ op: 'agent_response', request_id: 'n1', to_device_id: target, ok: true, result: {} })
    const err = await agent.waitFor((f) => f.op === 'error')
    assert.equal(err.code, 'not_found')
    assert.equal(err.request_id, 'n1')
  }
})

test('malformed agent_response fields -> bad_request', async (t) => {
  const { s, ag, login } = await setup(t)
  const agent = await open(s, ag.token)
  const to = login.json.device_id
  const bads = [
    { op: 'agent_response', to_device_id: to, ok: true },                                       // missing request_id
    { op: 'agent_response', request_id: 'r', to_device_id: to, ok: 'yes' },                     // non-boolean ok
    { op: 'agent_response', request_id: 'r', to_device_id: 'five', ok: true },                  // non-integer device id
    { op: 'agent_response', request_id: 'r', to_device_id: to, ok: false },                     // ok:false without error
    { op: 'agent_response', request_id: 'r', to_device_id: to, ok: false, error: {} },          // error without code
    { op: 'agent_response', request_id: 'r', to_device_id: to, ok: false, error: { code: 'c'.repeat(65) } }, // long code
  ]
  for (const bad of bads) {
    agent.frames.length = 0
    agent.send(bad)
    const err = await agent.waitFor((f) => f.op === 'error')
    assert.equal(err.code, 'bad_request')
  }
})

test('response multicasts to every live socket of the client device', async (t) => {
  const { s, ag, login } = await setup(t)
  const clientA = await open(s, login.json.token)   // same device token twice
  const clientB = await open(s, login.json.token)   // = two sockets, one device
  const agent = await open(s, ag.token)
  agent.send({ op: 'agent_response', request_id: 'm1', to_device_id: login.json.device_id, ok: true, result: 1 })
  const fa = await clientA.waitFor((x) => x.kind === 'rpc')
  const fb = await clientB.waitFor((x) => x.kind === 'rpc')
  assert.equal(fa.response.request_id, 'm1')
  assert.equal(fb.response.request_id, 'm1')
})

test('response after the requesting client disconnected is dropped without crashing', async (t) => {
  const { s, ag, login } = await setup(t)
  const client = await open(s, login.json.token)
  const agent = await open(s, ag.token)
  client.send({ op: 'agent_request', request_id: 'd1', agent_device_id: ag.deviceId, method: 'start' })
  const req = await agent.waitFor((x) => x.kind === 'rpc')
  client.close()
  // wait until the server has fully unregistered the client socket
  await new Promise((r) => setTimeout(r, 100))
  agent.send({ op: 'agent_response', request_id: 'd1', to_device_id: req.request.from_device_id, ok: true, result: {} })
  // server must still be alive and the agent socket functional: a second
  // malformed op still draws its error frame
  agent.frames.length = 0
  agent.send({ op: 'agent_response', request_id: 'd2', to_device_id: 'bogus', ok: true })
  const err = await agent.waitFor((f) => f.op === 'error')
  assert.equal(err.code, 'bad_request')
})
