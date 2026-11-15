// tools/conformance-server.js: serve mode (a seeded journal any client can
// spawn, admin steps over a control socket), overrides, and replay mode.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import fs from 'node:fs'
import { replayFixture } from '../tools/conformance/coordinator.js'
import { connectControl } from '../tools/conformance/server.js'
import { createActor } from '../tools/conformance/actor.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const CLI = path.join(__dirname, '..', 'tools', 'conformance-server.js')
const STUB = path.join(__dirname, '..', 'tools', 'conformance', 'stub-runner.js')
const FIX = (f) => path.join(__dirname, 'fixtures', 'conformance', f)

function startCli(t, args, env = {}) {
  const child = spawn(process.execPath, [CLI, ...args], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, ...env } })
  t.after(() => child.kill())
  const rl = readline.createInterface({ input: child.stdout })
  const first = new Promise((resolve, reject) => {
    rl.once('line', (l) => resolve(JSON.parse(l)))
    child.once('exit', (c) => reject(new Error(`cli exited ${c} before printing its base url`)))
  })
  return { child, first }
}

test('serve mode prints base, bindings and a control socket, and runs admin steps over it', async (t) => {
  const fixture = JSON.parse(fs.readFileSync(FIX('12_revocation.json'), 'utf8'))
  const { child, first } = startCli(t, [FIX('12_revocation.json')])
  const info = await first
  assert.match(info.base, /^http:\/\/127\.0\.0\.1:\d+$/)
  assert.ok(info.bindings['alice.user_id'] !== undefined)
  // The coordinator runs against this out-of-process server; the revocation
  // step reaches the database only through the control socket.
  const result = await replayFixture({
    fixture, base: info.base, bindings: info.bindings, control: connectControl(info.control),
    runner: createActor({ base: info.base }), play: ['client'],
  })
  assert.equal(result.status, 'pass', result.error)
  child.stdin.end()
  await new Promise((r) => child.once('exit', r))
})

test('env vars override the fixture server settings: a lowered maxReplay forces snapshot_required', async (t) => {
  // 03c replays 3 events after cursor 2 with the default window; a window of 1
  // makes the same hello draw snapshot_required instead.
  const fixture = JSON.parse(fs.readFileSync(FIX('03c_ws_hello_cursor_replay_order.json'), 'utf8'))
  const { child, first } = startCli(t, [FIX('03c_ws_hello_cursor_replay_order.json')], { MATRON_CONFORMANCE_MAX_REPLAY: '1' })
  const info = await first
  const result = await replayFixture({ fixture, base: info.base, bindings: info.bindings, control: connectControl(info.control), runner: createActor({ base: info.base }), play: ['client'] })
  assert.equal(result.status, 'fail', 'the default-window expectations must not hold with maxReplay=1')
  child.stdin.end()
  await new Promise((r) => child.once('exit', r))
})

test('replay mode: the built-in runner and a stdio runner both pass a fixture', () => {
  const a = spawnSync(process.execPath, [CLI, '--replay', FIX('08_ack_advances_cursor.json')], { encoding: 'utf8' })
  assert.equal(a.status, 0, a.stdout + a.stderr)
  assert.equal(JSON.parse(a.stdout.trim().split('\n').pop()).status, 'pass')
  const b = spawnSync(process.execPath, [CLI, '--replay', FIX('08_ack_advances_cursor.json'), '--runner', process.execPath, '--runner-arg', STUB, '--play', 'client'], { encoding: 'utf8' })
  assert.equal(b.status, 0, b.stdout + b.stderr)
  assert.equal(JSON.parse(b.stdout.trim().split('\n').pop()).status, 'pass')
})

test('the CLI refuses a fixture that fails the schema', () => {
  const bad = path.join(fs.mkdtempSync(path.join(fs.realpathSync('/tmp'), 'conf-cli-')), 'bad.json')
  const f = JSON.parse(fs.readFileSync(FIX('01_login.json'), 'utf8'))
  delete f.protocol
  fs.writeFileSync(bad, JSON.stringify(f))
  const r = spawnSync(process.execPath, [CLI, bad], { encoding: 'utf8' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /protocol/)
  fs.rmSync(path.dirname(bad), { recursive: true, force: true })
})
