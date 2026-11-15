#!/usr/bin/env node
// Seeded journal and replay coordinator for the conformance fixtures
// (test/fixtures/conformance/README.md).
//
// Serve mode: boot a seeded journal for one fixture and let a client in any
// language drive it.
//
//   node tools/conformance-server.js <fixture.json> [--max-replay N] [--media-max-bytes N] [--tmp-db]
//
//   Prints one JSON line on stdout: {"fixture":"...","base":"http://127.0.0.1:PORT",
//   "bindings":{...},"control":"/path/to/control.sock"}. The seed's bindings
//   (user ids, agent tokens) are in it. Admin steps run over the control socket
//   (see tools/conformance/server.js). The server stops when stdin closes, or on
//   SIGINT or SIGTERM.
//
// Replay mode: run a whole fixture through the coordinator.
//
//   node tools/conformance-server.js --replay <fixture.json> [--runner <command> [--runner-arg A]...]
//        [--play client|client:<name>] [--no-barrier] [--client-protocol N] [overrides]
//
//   With no --runner, the built-in Node runner plays the client role. With one,
//   it is spawned and speaks the stdio runner protocol (tools/conformance/stdio-runner.js)
//   for the lanes named by --play (default: every client). Prints one JSON line
//   with the result and exits 0 on pass or skip, 1 on a failure, 2 on bad usage.
//
// Server overrides (flag, else environment variable, else the fixture's `server`):
//   --max-replay N        MATRON_CONFORMANCE_MAX_REPLAY
//   --media-max-bytes N   MATRON_CONFORMANCE_MEDIA_MAX_BYTES
//   --tmp-db              MATRON_CONFORMANCE_TMP_DB=1
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bootFixtureServer, serveControl } from './conformance/server.js'
import { validateFixture } from './conformance/schema.js'
import { createActor } from './conformance/actor.js'
import { replayFixture } from './conformance/coordinator.js'
import { spawnRunner } from './conformance/stdio-runner.js'

function usage(msg) {
  if (msg) console.error(msg)
  console.error('usage: conformance-server.js <fixture.json> [overrides]\n       conformance-server.js --replay <fixture.json> [--runner CMD [--runner-arg A]...] [--play client|client:NAME] [--no-barrier] [--client-protocol N] [overrides]')
  process.exit(2)
}

export function parseArgs(argv, env = process.env) {
  const o = { runnerArgs: [], play: [], overrides: {}, barrier: true, replay: false, fixturePath: null }
  const intArg = (name, v) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 0) usage(`${name} needs a non-negative integer`)
    return n
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => { if (i + 1 >= argv.length) usage(`${a} needs a value`); return argv[++i] }
    if (a === '--replay') o.replay = true
    else if (a === '--runner') o.runner = next()
    else if (a === '--runner-arg') o.runnerArgs.push(next())
    else if (a === '--play') o.play.push(next())
    else if (a === '--no-barrier') o.barrier = false
    else if (a === '--client-protocol') o.clientProtocol = intArg(a, next())
    else if (a === '--max-replay') o.overrides.maxReplay = intArg(a, next())
    else if (a === '--media-max-bytes') o.overrides.mediaMaxBytes = intArg(a, next())
    else if (a === '--tmp-db') o.overrides.tmpDb = true
    else if (a.startsWith('--')) usage(`unknown flag ${a}`)
    else if (o.fixturePath === null) o.fixturePath = a
    else usage(`unexpected argument ${a}`)
  }
  if (o.overrides.maxReplay === undefined && env.MATRON_CONFORMANCE_MAX_REPLAY) o.overrides.maxReplay = intArg('MATRON_CONFORMANCE_MAX_REPLAY', env.MATRON_CONFORMANCE_MAX_REPLAY)
  if (o.overrides.mediaMaxBytes === undefined && env.MATRON_CONFORMANCE_MEDIA_MAX_BYTES) o.overrides.mediaMaxBytes = intArg('MATRON_CONFORMANCE_MEDIA_MAX_BYTES', env.MATRON_CONFORMANCE_MEDIA_MAX_BYTES)
  if (o.overrides.tmpDb === undefined && ['1', 'true'].includes(env.MATRON_CONFORMANCE_TMP_DB)) o.overrides.tmpDb = true
  return o
}

async function main() {
  const o = parseArgs(process.argv.slice(2))
  if (!o.fixturePath) usage('a fixture path is required')
  let fixture
  try { fixture = JSON.parse(fs.readFileSync(o.fixturePath, 'utf8')) } catch (e) { usage(`cannot read fixture: ${e.message}`) }
  const errs = validateFixture(fixture)
  if (errs.length) {
    console.error(`fixture does not match the schema:\n  ${errs.join('\n  ')}`)
    process.exit(2)
  }
  // The server logs progress with console.log. Keep stdout for the one JSON
  // line a caller parses.
  const emit = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
  console.log = (...a) => console.error(...a)
  const booted = await bootFixtureServer(fixture, o.overrides)

  if (o.replay) {
    let runner
    let play = o.play
    if (o.runner) {
      runner = await spawnRunner({ command: o.runner, args: o.runnerArgs, base: booted.base, fixture: fixture.name })
      if (!play.length) play = ['client']
    } else {
      runner = createActor({ base: booted.base })
      play = ['client']
    }
    const result = await replayFixture({
      fixture, base: booted.base, bindings: booted.bindings, control: booted.control,
      runner, play, barrier: o.barrier, clientProtocol: o.clientProtocol,
    })
    await runner.close()
    await booted.close()
    emit({ fixture: fixture.name, ...result })
    process.exit(result.status === 'fail' || result.status === 'invalid' ? 1 : 0)
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-conformance-ctl-'))
  fs.chmodSync(dir, 0o700)
  const sock = path.join(dir, 'control.sock')
  const ctl = await serveControl(booted.control, sock)
  emit({ fixture: fixture.name, base: booted.base, bindings: booted.bindings, control: sock })
  let stopping = false
  const stop = async () => {
    if (stopping) return
    stopping = true
    ctl.close()
    await booted.close()
    fs.rmSync(dir, { recursive: true, force: true })
    process.exit(0)
  }
  process.stdin.on('end', stop)
  process.stdin.resume()
  process.on('SIGINT', stop)
  process.on('SIGTERM', stop)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(1) })
}
