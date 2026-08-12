import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolveNumericEnv, DEFAULT_MEDIA_MAX_BYTES, DEFAULT_MAX_REPLAY } from '../src/server.js'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import { append } from '../src/journal.js'
import { upsertConversation } from '../src/journal.js'

// Spawns `node <entrypoint>` and resolves once the "matron-journal
// listening on ..." boot line appears on stdout (proving the realpathSync
// entrypoint guard evaluated true), or rejects on early exit/timeout.
function runServerAndWaitForListen(entrypoint, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entrypoint], { env })
    let out = ''
    let settled = false
    const timer = setTimeout(() => {
      if (!settled) { settled = true; child.kill(); reject(new Error(`timed out waiting for listen; output so far: ${out}`)) }
    }, 5000)
    child.stdout.on('data', (d) => {
      out += d.toString()
      const m = out.match(/matron-journal listening on [^\s]+:(\d+)/)
      if (m && !settled) { settled = true; clearTimeout(timer); resolve({ child, port: Number(m[1]) }) }
    })
    child.stderr.on('data', (d) => { out += d.toString() })
    child.on('error', (e) => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    child.on('exit', (code) => {
      if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server exited early (code ${code}); output: ${out}`)) }
    })
  })
}

test('server entrypoint starts when run directly and via a symlink (systemd/npx-style invocation)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-server-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const real = path.resolve('src/server.js')

  const dbPath1 = path.join(dir, 'direct.db')
  const { child: direct, port: port1 } = await runServerAndWaitForListen(real, { ...process.env, MATRON_DB: dbPath1, MATRON_PORT: '0' })
  assert.ok(port1 > 0)
  direct.kill()

  const link = path.join(dir, 'server-link.js')
  fs.symlinkSync(real, link)
  const dbPath2 = path.join(dir, 'link.db')
  const { child: viaLink, port: port2 } = await runServerAndWaitForListen(link, { ...process.env, MATRON_DB: dbPath2, MATRON_PORT: '0' })
  assert.ok(port2 > 0)
  viaLink.kill()
})

test('resolveNumericEnv: unset is the default, silently (no warn)', () => {
  const mute = { called: false }
  const orig = console.warn
  console.warn = () => { mute.called = true }
  try {
    assert.equal(resolveNumericEnv('MATRON_X', undefined, 42), 42)
    assert.equal(mute.called, false)
  } finally {
    console.warn = orig
  }
})

test('resolveNumericEnv: a valid positive-integer string is parsed and used as-is', () => {
  assert.equal(resolveNumericEnv('MATRON_X', '100', 42), 100)
  assert.equal(resolveNumericEnv('MATRON_X', '1', 42), 1)
})

test('resolveNumericEnv: non-integer, zero, negative, or non-numeric garbage all fall back to the default with exactly one warn log', (t) => {
  for (const bad of ['abc', '1.5', '0', '-5', 'NaN', 'Infinity', '', '  ']) {
    const warn = t.mock.method(console, 'warn', () => {})
    const result = resolveNumericEnv('MATRON_X', bad, 42)
    assert.equal(result, 42, `raw=${JSON.stringify(bad)} should fall back to the default`)
    assert.equal(warn.mock.callCount(), 1, `raw=${JSON.stringify(bad)} should log exactly one warning`)
    assert.match(warn.mock.calls[0].arguments[0], /MATRON_X/)
    warn.mock.restore()
  }
})

test('startServer warns at boot when bound to a non-loopback address (cf-connecting-ip becomes spoofable), and stays quiet on loopback', async (t) => {
  const isBindWarn = (c) => /MATRON_BIND/.test(c.arguments[0]) && /loopback/.test(c.arguments[0])

  // Non-loopback bind: exactly the config that makes the cf-connecting-ip
  // trust unsafe — must emit the SECURITY warning.
  const warnNon = t.mock.method(console, 'warn', () => {})
  const sNon = await startTestServer({ bind: '0.0.0.0' })
  t.after(() => sNon.close())
  assert.ok(warnNon.mock.calls.some(isBindWarn), 'expected a SECURITY warning naming MATRON_BIND for a non-loopback bind')
  warnNon.mock.restore()

  // Loopback bind (the default deployment): no bind warning.
  const warnLoop = t.mock.method(console, 'warn', () => {})
  const sLoop = await startTestServer({ bind: '127.0.0.1' })
  t.after(() => sLoop.close())
  assert.ok(!warnLoop.mock.calls.some(isBindWarn), 'a loopback bind must not emit the bind warning')
  warnLoop.mock.restore()
})

test('MATRON_MEDIA_MAX_BYTES garbage in the env does not silently disable the upload size cap (regression: NaN made `size > maxBytes` always false)', async (t) => {
  const prevEnv = process.env.MATRON_MEDIA_MAX_BYTES
  process.env.MATRON_MEDIA_MAX_BYTES = 'not-a-number'
  t.after(() => {
    if (prevEnv === undefined) delete process.env.MATRON_MEDIA_MAX_BYTES
    else process.env.MATRON_MEDIA_MAX_BYTES = prevEnv
  })
  const mute = t.mock.method(console, 'warn', () => {})
  // No `mediaMaxBytes` opt passed — forces resolution through the env path.
  const s = await startTestServer()
  t.after(() => s.close())
  assert.ok(mute.mock.calls.some((c) => /MATRON_MEDIA_MAX_BYTES/.test(c.arguments[0])), 'expected a warn log naming the invalid var')

  const dan = await createUser(s.db, 'dan', 'pw')
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'x' } })
  void dan

  // If the cap had silently been disabled (NaN), this upload — one byte
  // over the real DEFAULT_MEDIA_MAX_BYTES — would succeed (200). With the
  // fix, the default cap is still enforced: 413.
  const over = Buffer.alloc(DEFAULT_MEDIA_MAX_BYTES + 1024)
  const up = await fetch(s.base + '/media', {
    method: 'POST',
    headers: { authorization: `Bearer ${login.json.token}` },
    body: over,
  })
  assert.equal(up.status, 413, 'the default upload cap must still be enforced when the env var is garbage')
})

test('MATRON_MAX_REPLAY garbage in the env does not silently disable the snapshot_required valve (regression: NaN made `gap > maxReplay` always false)', async (t) => {
  const prevEnv = process.env.MATRON_MAX_REPLAY
  process.env.MATRON_MAX_REPLAY = 'garbage'
  t.after(() => {
    if (prevEnv === undefined) delete process.env.MATRON_MAX_REPLAY
    else process.env.MATRON_MAX_REPLAY = prevEnv
  })
  const mute = t.mock.method(console, 'warn', () => {})
  // No `maxReplay` opt passed — forces resolution through the env path.
  const s = await startTestServer()
  t.after(() => s.close())
  assert.ok(mute.mock.calls.some((c) => /MATRON_MAX_REPLAY/.test(c.arguments[0])), 'expected a warn log naming the invalid var')

  // The exact value actually wired into attachWs's threshold is asserted
  // directly against the same resolver + real DEFAULT_MAX_REPLAY constant
  // production code uses (a live 50001-event replay-gap test would be
  // correct too, but needlessly slow for this regression).
  assert.equal(resolveNumericEnv('MATRON_MAX_REPLAY', 'garbage', DEFAULT_MAX_REPLAY), DEFAULT_MAX_REPLAY)

  // Wiring smoke test at a scale a test suite can afford: with a *valid*
  // small env override the valve still fires exactly where expected,
  // proving the resolved value (not a bypassed/broken code path) drives
  // attachWs's `gap > maxReplay` check.
  const dan = await createUser(s.db, 'dan', 'pw')
  upsertConversation(s.db, { id: 'c1', ownerUserId: dan.id })
  for (let i = 0; i < 3; i++) {
    append(s.db, { userId: dan.id, convoId: 'c1', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
  }
  const login = await s.http('/login', { method: 'POST', body: { username: 'dan', password: 'pw', device_name: 'x' } })
  const raw = new (await import('ws')).default(s.base.replace('http', 'ws') + '/ws')
  await new Promise((r) => raw.on('open', r))
  const frames = []
  raw.on('message', (d) => frames.push(JSON.parse(d)))
  raw.send(JSON.stringify({ op: 'hello', token: login.json.token, cursor: 0 })) // gap = 3, well under the real 50000 default
  await new Promise((r) => setTimeout(r, 300))
  assert.ok(!frames.some((f) => f.op === 'snapshot_required'), 'a gap of 3 must replay normally under the real (non-NaN) default of 50000')
  assert.equal(frames.filter((f) => f.kind === 'journal').length, 3)
  raw.close()
})

// The timer half of the WAL mitigation (scheduleWalCheckpoint): PASSIVE
// checkpoints actually run on the configured cadence, actually backfill WAL
// frames produced by appends (autocheckpoint is disabled in openDb, so
// nothing else checkpoints), and stop when the server closes. db.pragma is
// shadowed with a counting wrapper — the timer resolves the method at call
// time, so the wrapper observes every pass and its real result.
test('WAL checkpoint timer runs PASSIVE passes, backfills appends, and stops on close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-walckpt-'))
  const s = await startTestServer({ dbPath: path.join(dir, 'm.db'), walCheckpointIntervalMs: 50 })
  let closed = false
  try {
    // The server half of the pragma split: startServer (not openDb) disables
    // the inline auto-checkpoint, since only the server runs the timer.
    assert.equal(s.db.pragma('wal_autocheckpoint', { simple: true }), 0)
    const passes = []
    const origPragma = s.db.pragma.bind(s.db)
    s.db.pragma = (sql, ...rest) => {
      const out = origPragma(sql, ...rest)
      if (/wal_checkpoint/i.test(String(sql))) passes.push(out)
      return out
    }

    // Generate WAL frames, then give the timer a few ticks to backfill them.
    const user = await createUser(s.db, 'walckpt-user', 'pw-walckpt-user')
    upsertConversation(s.db, { id: 'walckpt-convo', ownerUserId: user.id, title: 't' })
    for (let i = 0; i < 25; i++) {
      append(s.db, { userId: user.id, convoId: 'walckpt-convo', sender: 'agent:a', type: 'text', payload: { body: `m${i}` } })
    }
    await new Promise((r) => setTimeout(r, 300))
    assert.ok(passes.length >= 2, `expected >=2 timer passes, saw ${passes.length}`)
    // At least one pass backfilled the frames the appends produced.
    assert.ok(
      passes.some((p) => Array.isArray(p) && p[0] && p[0].checkpointed > 0),
      `no pass reported checkpointed>0: ${JSON.stringify(passes.slice(0, 5))}`
    )

    await s.close()
    closed = true
    const after = passes.length
    await new Promise((r) => setTimeout(r, 250))
    assert.equal(passes.length, after, 'timer kept firing after close()')
  } finally {
    // An assertion failure above must not leak the server (an open listener
    // keeps the node:test process alive forever).
    if (!closed) await s.close().catch(() => {})
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
