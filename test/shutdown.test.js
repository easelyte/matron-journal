import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { startTestServer, makeWsClient } from './helpers.js'
import { openDb } from '../src/db.js'
import { createUser, createAgent } from '../src/auth.js'
import { installShutdownHandlers, RESTART_CLOSE_CODE, RESTART_CLOSE_REASON } from '../src/server.js'

// A planned stop tells every connected client it is a restart (close code
// 1012, reason "restarting") so a client can reconnect straight away rather
// than treat the drop as a network failure.

function closeInfo(ws) {
  return new Promise((resolve) => ws.once('close', (code, reason) => resolve({ code, reason: reason.toString() })))
}

test('close({closeCode}) sends every socket the close code and reason, then shuts down', async (t) => {
  const s = await startTestServer()
  const a = await createUser(s.db, 'alice', 'pw')
  const dev = createAgent(s.db, a.id, 'jade')
  const c1 = await makeWsClient(s.base, { token: dev.token, cursor: null })
  const c2 = await makeWsClient(s.base, { token: dev.token, cursor: null })
  await c1.waitFor((f) => f.op === 'hello_ok')
  await c2.waitFor((f) => f.op === 'hello_ok')
  const got = [closeInfo(c1.ws), closeInfo(c2.ws)]
  await s.close({ closeCode: RESTART_CLOSE_CODE, closeReason: RESTART_CLOSE_REASON })
  for (const g of await Promise.all(got)) assert.deepEqual(g, { code: 1012, reason: 'restarting' })
})

test('close() without a code still terminates sockets as before', async () => {
  const s = await startTestServer()
  const a = await createUser(s.db, 'alice', 'pw')
  const dev = createAgent(s.db, a.id, 'jade')
  const c = await makeWsClient(s.base, { token: dev.token, cursor: null })
  await c.waitFor((f) => f.op === 'hello_ok')
  const got = closeInfo(c.ws)
  await s.close()
  assert.notEqual((await got).code, 1012)
})

test('the signal handler closes the server with 1012 and exits 0; a stuck close exits 1', async () => {
  const proc = new EventEmitter()
  const exits = []
  proc.exit = (c) => exits.push(c)
  const calls = []
  installShutdownHandlers({ close: (o) => { calls.push(o); return Promise.resolve() } }, { proc, log: () => {} })
  proc.emit('SIGTERM')
  proc.emit('SIGINT') // second signal while stopping is ignored
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls.length, 1)
  assert.equal(calls[0].closeCode, 1012)
  assert.equal(calls[0].closeReason, 'restarting')
  assert.deepEqual(exits, [0])

  const stuckProc = new EventEmitter()
  const stuckExits = []
  stuckProc.exit = (c) => stuckExits.push(c)
  installShutdownHandlers({ close: () => new Promise(() => {}) }, { proc: stuckProc, timeoutMs: 30, log: () => {} })
  stuckProc.emit('SIGINT')
  await new Promise((r) => setTimeout(r, 120))
  assert.deepEqual(stuckExits, [1])
})

test('a running journal process gives clients 1012 on SIGTERM and exits 0', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-shutdown-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const dbPath = path.join(dir, 'j.db')
  const seed = openDb(dbPath)
  const a = await createUser(seed, 'alice', 'pw')
  const dev = createAgent(seed, a.id, 'jade')
  seed.close()

  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/server.js', import.meta.url))], {
    env: { ...process.env, MATRON_DB: dbPath, MATRON_PORT: '0' },
  })
  t.after(() => child.kill('SIGKILL'))
  const port = await new Promise((resolve, reject) => {
    let out = ''
    const timer = setTimeout(() => reject(new Error(`no listen: ${out}`)), 8000)
    child.stdout.on('data', (d) => {
      out += d
      const m = out.match(/listening on [^\s]+:(\d+)/)
      if (m) { clearTimeout(timer); resolve(Number(m[1])) }
    })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (c) => reject(new Error(`exited early ${c}: ${out}`)))
  })
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })))
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
  ws.send(JSON.stringify({ op: 'hello', token: dev.token, cursor: null }))
  await new Promise((resolve) => ws.once('message', resolve))
  const closed = closeInfo(ws)
  child.kill('SIGTERM')
  assert.deepEqual(await closed, { code: 1012, reason: 'restarting' })
  assert.deepEqual(await exited, { code: 0, signal: null })
})
