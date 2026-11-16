import test from 'node:test'
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import http from 'node:http'
import crypto from 'node:crypto'
import { startTestServer, makeWsClient } from './helpers.js'
import { createUser } from '../src/auth.js'
import { append, appendAndBroadcast, upsertConversation } from '../src/journal.js'

async function seed(s) {
  const user = await createUser(s.db, 'user', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: user.id })
  // One large, compressible row (well over the 1 KiB threshold) and one tiny one.
  append(s.db, { userId: user.id, convoId: 'c1', sender: 'agent:a', type: 'tool_output', payload: { text: 'line of build output\n'.repeat(400) } })
  append(s.db, { userId: user.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: 'hi' } })
  const login = await s.http('/login', { method: 'POST', body: { username: 'user', password: 'pw', device_name: 'test' } })
  return login.json.token
}

// Raw socket bytes read for a full replay of the seeded rows, with or without
// the client offering permessage-deflate.
async function replayBytes(t, s, token, offerDeflate) {
  const ws = new WebSocket(s.base.replace('http', 'ws') + '/ws', { perMessageDeflate: offerDeflate })
  t.after(() => ws.terminate())
  let negotiated = ''
  ws.on('upgrade', (res) => { negotiated = res.headers['sec-websocket-extensions'] ?? '' })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const frames = []
  ws.on('message', (d) => frames.push(JSON.parse(d)))
  ws.send(JSON.stringify({ op: 'hello', token, cursor: 0 }))
  const t0 = Date.now()
  while (frames.filter((f) => f.kind === 'journal').length < 2 && Date.now() - t0 < 3000) await new Promise((r) => setTimeout(r, 10))
  assert.equal(frames.filter((f) => f.kind === 'journal').length, 2, 'replay completes')
  const out = { extensions: ws.extensions, negotiated, bytes: ws._socket.bytesRead, frames }
  ws.close()
  return out
}

test('permessage-deflate is negotiated by default and shrinks large frames without changing them', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const token = await seed(s)
  const plain = await replayBytes(t, s, token, false)
  const deflated = await replayBytes(t, s, token, true)
  assert.equal(plain.extensions, '')
  assert.match(deflated.extensions, /permessage-deflate/)
  // No zlib context carried between messages (see WS_DEFLATE_OPTIONS).
  assert.match(deflated.negotiated, /server_no_context_takeover/)
  assert.match(deflated.negotiated, /client_no_context_takeover/)
  assert.match(deflated.negotiated, /server_max_window_bits=11/)
  t.diagnostic(`replay bytes including handshake: ${plain.bytes} plain, ${deflated.bytes} compressed`)
  assert.deepEqual(
    deflated.frames.filter((f) => f.kind === 'journal'),
    plain.frames.filter((f) => f.kind === 'journal'),
    'decoded frames are identical either way',
  )
  assert.ok(deflated.bytes < plain.bytes / 3, `expected a large reduction, got ${plain.bytes} -> ${deflated.bytes}`)
})

test('a client that does not offer the extension is served plain frames (wire-compatible)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const token = await seed(s)
  const plain = await replayBytes(t, s, token, false)
  assert.equal(plain.extensions, '')
  assert.equal(plain.frames.filter((f) => f.kind === 'journal').length, 2)
})

test('wsDeflate:false turns the extension off', async (t) => {
  const s = await startTestServer({ wsDeflate: false })
  t.after(() => s.close())
  const token = await seed(s)
  const offered = await replayBytes(t, s, token, true)
  assert.equal(offered.extensions, '')
  assert.equal(offered.frames.filter((f) => f.kind === 'journal').length, 2)
})

test('MATRON_WS_DEFLATE=0 disables negotiation and an explicit option overrides it', async (t) => {
  const previous = process.env.MATRON_WS_DEFLATE
  process.env.MATRON_WS_DEFLATE = '0'
  t.after(() => {
    if (previous === undefined) delete process.env.MATRON_WS_DEFLATE
    else process.env.MATRON_WS_DEFLATE = previous
  })
  for (const [opts, compressed] of [[{}, false], [{ wsDeflate: true }, true]]) {
    const s = await startTestServer(opts)
    t.after(() => s.close())
    const result = await rawUpgrade(s.base, 'permessage-deflate')
    assert.equal(result.status, 101)
    assert.equal(result.ext.includes('permessage-deflate'), compressed)
  }
})

test('ordinary clients keep working over a deflated socket (live fan-out after replay)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const token = await seed(s)
  const c = await makeWsClient(s.base, { token, cursor: 0 })
  t.after(() => c.ws.terminate())
  await c.waitFor((f) => f.kind === 'journal' && f.seq === 2)
  assert.match(c.ws.extensions, /permessage-deflate/)
  const user = s.db.prepare('SELECT id FROM users WHERE name=?').get('user')
  const event = appendAndBroadcast(s.db, s.hub, {
    userId: user.id, convoId: 'c1', sender: 'agent:a', type: 'text',
    payload: { body: 'live message '.repeat(200) },
  })
  const frame = await c.waitFor((f) => f.kind === 'journal' && f.seq === event.seq)
  assert.equal(frame.payload.body, 'live message '.repeat(200))
  c.close()
})

// A raw upgrade with an arbitrary Sec-WebSocket-Extensions offer; resolves to
// the handshake status and the negotiated extension header.
function rawUpgrade(base, offer) {
  const u = new URL(base)
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: '/ws',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'),
        ...(offer === undefined ? {} : { 'Sec-WebSocket-Extensions': offer }),
      },
    })
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ status: res.statusCode, ext: res.headers['sec-websocket-extensions'] ?? '' }) })
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode, ext: '' }) })
    req.on('error', reject)
    req.end()
  })
}

test('every valid deflate offer shape still completes the handshake (never a 400)', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const offers = [
    undefined, // no extension offered at all
    'permessage-deflate', // bare offer without window parameters
    'permessage-deflate; client_max_window_bits', // unspecified client window
    'permessage-deflate; server_max_window_bits=9', // asks for a smaller window than the server's 11 (connects uncompressed)
    'permessage-deflate; server_max_window_bits=9, permessage-deflate', // a second offer is still accepted
    'permessage-deflate; client_max_window_bits=10; server_no_context_takeover',
    'unknown-extension', // an unknown extension only
  ]
  for (const offer of offers) {
    const r = await rawUpgrade(s.base, offer)
    assert.equal(r.status, 101, `offer ${JSON.stringify(offer)} must upgrade`)
    if (offer === 'permessage-deflate; server_max_window_bits=9') assert.equal(r.ext, '', 'an unsatisfiable window offer connects uncompressed')
    else if (offer && offer.startsWith('permessage-deflate')) assert.match(r.ext, /^permessage-deflate/, `offer ${offer} negotiates`)
    else assert.equal(r.ext, '')
  }
})
