// Decoder extracts: payloads/<frame-type>.json, generated from the fixtures.
//
// Every fixture is replayed once against a real journal. For each expected
// frame (ws_expect) and each JSON response body (http) the fixture matched, the
// extract keeps what the server really sent, with every value the fixture
// treats as variable ($bind, $ref, $type, $ignore) replaced by a stable sample
// value, so two generations are byte-identical.
import fs from 'node:fs'
import path from 'node:path'
import { CONFORMANCE_DIR } from './schema.js'
import { bootFixtureServer } from './server.js'
import { replayFixture } from './coordinator.js'
import { createActor, MODEL_CAPABILITIES } from './actor.js'

export const PAYLOADS_DIR = path.join(CONFORMANCE_DIR, 'payloads')

const isVar = (x) => x !== null && typeof x === 'object' && !Array.isArray(x) &&
  ('$bind' in x || '$ref' in x || '$type' in x || '$ignore' in x)

// FNV-1a, so a named binding maps to the same number in every fixture.
function hash(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0 }
  return h
}

// A scalar stand-in for a value the fixture does not pin. `name` is the
// binding name when there is one (so every use of one binding agrees), else
// the key the value sat under.
export function sampleScalar(actual, name, key) {
  if (typeof actual === 'string') return `sample-${name ?? key ?? 'string'}`
  if (typeof actual === 'number') {
    if (!Number.isInteger(actual)) return 1.5
    if (name !== undefined) return 1000 + (hash(name) % 9000)
    return key === 'ts' || /_at$|^ts$/.test(key || '') ? 1700000000000 : 1
  }
  return actual // booleans and null are not dynamic
}

// A whole value the fixture does not pin: scalars via sampleScalar, containers
// walked with every scalar replaced.
function sampleAny(actual, name, key) {
  if (Array.isArray(actual)) return actual.map((v) => sampleAny(v, undefined, key))
  if (actual !== null && typeof actual === 'object') {
    const out = {}
    for (const k of Object.keys(actual)) out[k] = sampleAny(actual[k], undefined, k)
    return out
  }
  return sampleScalar(actual, name, key)
}

// Walk the fixture's expectation next to what was observed. Literals are kept
// from the expectation (they equal the observation), variable nodes become
// samples of the observed value.
export function resolveSample(template, actual, key) {
  if (isVar(template)) {
    const name = template.$bind ?? template.$ref
    return sampleAny(actual, name, key)
  }
  if (Array.isArray(template)) return template.map((t, i) => resolveSample(t, actual[i], key))
  if (template !== null && typeof template === 'object') {
    const out = {}
    for (const k of Object.keys(template)) out[k] = resolveSample(template[k], actual[k], k)
    return out
  }
  return template
}

function wsType(frame) {
  const kind = frame.kind
  if (kind === 'journal') return `ws.journal.${frame.type}`
  if (typeof frame.op === 'string') return `ws.${kind}.${frame.op}`
  // ephemerals and other frames: the first payload key that is not routing
  const skip = new Set(['kind', 'convo_id', 'message_ref', 'seq', 'ts', 'sender', 'sender_device_id'])
  const sub = Object.keys(frame).sort().find((k) => !skip.has(k))
  return sub ? `ws.${kind}.${sub}` : `ws.${kind}`
}

function httpType(step, status) {
  const p = step.path.split('?')[0].replace(/\$\{[^}]+\}/g, '').split('/').filter((seg) => seg && !/^(c\d+|\d+|[0-9a-f]{16,})$/.test(seg)).join('.')
  return `http.${(step.method || 'GET').toLowerCase()}.${p.toLowerCase().replace(/[^a-z0-9_.]/g, '_')}.${status}`
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }))
  return results
}

export async function generateExtracts(fixtureDir = CONFORMANCE_DIR, { only } = {}) {
  // A fixture whose muting is the app's own write (set_app_state with `muted`) makes the
  // journal push frames only the app's settings call causes, so only an app can replay
  // it; the notify frame itself is shown by 21_notify_settings_push.json (plain HTTP).
  const needsApp = (f) => JSON.parse(fs.readFileSync(path.join(fixtureDir, f), 'utf8')).steps.some((s) => s.kind === 'set_app_state' && 'muted' in s)
  const all = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.json') && (!only || only.includes(f))).sort()
  for (const f of all.filter(needsApp)) console.error(`extracts: skipping ${f} (its muting is an app's own write)`)
  const files = all.filter((f) => !needsApp(f))
  // Replay every fixture (side by side, each against its own server), then
  // fold the observations in file order so the output does not depend on timing.
  const runs = await mapLimit(files, 3, async (file) => {
    const fixture = JSON.parse(fs.readFileSync(path.join(fixtureDir, file), 'utf8'))
    const booted = await bootFixtureServer(fixture)
    const collect = {}
    let result
    try {
      // The client lane runs on the Node actor; a step about an app's own model
      // (set_app_state, expect_model, expect_notification) has no app here and
      // passes: the frames around it are what the extracts are made from.
      const actor = createActor({ base: booted.base })
      const runner = {
        capabilities: new Set([...actor.capabilities, ...MODEL_CAPABILITIES]),
        run: async (step, bindings, info) => (MODEL_CAPABILITIES.includes(step.kind) ? { bindings: {}, observed: undefined } : actor.run(step, bindings, info)),
        close: () => actor.close(),
      }
      try {
        result = await replayFixture({ fixture, base: booted.base, bindings: booted.bindings, control: booted.control, collect, runner, play: ['client'] })
      } finally {
        await actor.close()
      }
    } finally {
      await booted.close()
    }
    if (result.status !== 'pass') throw new Error(`${file}: cannot extract from a fixture that does not pass (${result.status}: ${result.error ?? result.reason})`)
    return { file, fixture, collect }
  })
  const byType = new Map()
  for (const { file, fixture, collect } of runs) {
    for (const [i, step] of fixture.steps.entries()) {
      const obs = collect[i]
      let type, surface, frame
      if (step.kind === 'ws_expect' && obs?.frame) {
        surface = 'ws'
        type = wsType(obs.frame)
        frame = resolveSample(step.frame, obs.frame)
      } else if (step.kind === 'http' && obs?.body !== undefined && obs.body !== null && step.expect?.body !== undefined) {
        surface = 'http'
        type = httpType(step, obs.status)
        frame = resolveSample(step.expect.body, obs.body)
      } else continue
      if (!byType.has(type)) byType.set(type, { type, surface, protocol: fixture.protocol, samples: [] })
      const doc = byType.get(type)
      doc.protocol = Math.max(doc.protocol, fixture.protocol)
      const text = JSON.stringify(frame)
      if (!doc.samples.some((s) => JSON.stringify(s.frame) === text)) doc.samples.push({ source: `${file}#step[${i}]`, frame })
    }
  }
  const out = new Map()
  for (const type of [...byType.keys()].sort()) out.set(`${type}.json`, JSON.stringify(byType.get(type), null, 2) + '\n')
  return out
}

export function readCommitted(dir = PAYLOADS_DIR) {
  const out = new Map()
  if (!fs.existsSync(dir)) return out
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) out.set(f, fs.readFileSync(path.join(dir, f), 'utf8'))
  return out
}

// Frames in `fresh` that the committed extracts do not hold verbatim. A cheap
// way to check a subset of the fixtures without regenerating everything.
export function missingFrames(fresh, committed) {
  const out = []
  for (const [name, text] of fresh) {
    const have = committed.has(name) ? JSON.parse(committed.get(name)).samples.map((s) => JSON.stringify(s.frame)) : []
    for (const sample of JSON.parse(text).samples) {
      if (!have.includes(JSON.stringify(sample.frame))) out.push(`${name} ${sample.source}`)
    }
  }
  return out
}

// Names of files whose committed content differs from `fresh`, plus files that
// exist on only one side.
export function diffExtracts(fresh, committed) {
  const names = new Set([...fresh.keys(), ...committed.keys()])
  return [...names].sort().filter((n) => fresh.get(n) !== committed.get(n))
}

export function writeExtracts(fresh, dir = PAYLOADS_DIR) {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, text] of fresh) fs.writeFileSync(path.join(dir, name), text)
}
