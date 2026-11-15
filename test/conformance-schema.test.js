// The conformance format's JSON Schema (test/fixtures/conformance/schema/).
// Every committed fixture must validate, and the schema must reject the
// malformed shapes it exists to catch.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CONFORMANCE_DIR, validateFixture, validatePayloadExtract, validateKeyTable } from '../tools/conformance/schema.js'

const files = fs.readdirSync(CONFORMANCE_DIR).filter((f) => f.endsWith('.json')).sort()
const read = (...p) => JSON.parse(fs.readFileSync(path.join(CONFORMANCE_DIR, ...p), 'utf8'))

const base = () => ({
  name: 'n',
  description: 'd',
  protocol: 1,
  steps: [
    { kind: 'http', role: 'client', method: 'GET', path: '/metrics', expect: { status: 200 } },
  ],
})

test('every committed fixture validates against the schema', () => {
  assert.ok(files.length > 0)
  for (const f of files) {
    const errs = validateFixture(read(f))
    assert.deepEqual(errs, [], `${f}: ${errs.join('; ')}`)
  }
})

test('the schema rejects a step with no role', () => {
  const f = base()
  delete f.steps[0].role
  assert.notDeepEqual(validateFixture(f), [], 'a step without role must be rejected')
})

test('the schema rejects a fixture with no protocol', () => {
  const f = base()
  delete f.protocol
  assert.notDeepEqual(validateFixture(f), [], 'a fixture without protocol must be rejected')
})

test('the schema rejects an unknown field (fixture, step, server, seed)', () => {
  const a = base(); a.extra = 1
  assert.notDeepEqual(validateFixture(a), [], 'unknown fixture field')
  const b = base(); b.steps[0].extra = 1
  assert.notDeepEqual(validateFixture(b), [], 'unknown step field')
  const c = base(); c.server = { maxReplay: 5, bogus: true }
  assert.notDeepEqual(validateFixture(c), [], 'unknown server field')
  const d = base(); d.seed = { users: [{ as: 'alice', name: 'alice', password: 'pw', bogus: 1 }] }
  assert.notDeepEqual(validateFixture(d), [], 'unknown seed field')
})

test('the schema rejects a key row with no expected outcome', () => {
  const t = read('keys', 'message-box.json')
  assert.deepEqual(validateKeyTable(t), [])
  const bad = structuredClone(t)
  delete bad.rows[0].expect
  assert.notDeepEqual(validateKeyTable(bad), [], 'a key row without expect must be rejected')
})

test('the schema rejects an unknown step kind, a bad role, and a client id on a non-client step', () => {
  const a = base(); a.steps[0].kind = 'teleport'
  assert.notDeepEqual(validateFixture(a), [])
  const b = base(); b.steps[0].role = 'robot'
  assert.notDeepEqual(validateFixture(b), [])
  const c = base(); c.steps[0].role = 'agent'; c.steps[0].client = 'mac'
  assert.notDeepEqual(validateFixture(c), [])
})

test('the schema rejects since greater than protocol and a connection shared by two actors', () => {
  const a = base(); a.since = 2
  assert.notDeepEqual(validateFixture(a), [])
  const b = base()
  b.steps = [
    { kind: 'ws_open', role: 'client', conn: 'c' },
    { kind: 'ws_send', role: 'agent', conn: 'c', frame: { op: 'hello' } },
  ]
  assert.notDeepEqual(validateFixture(b), [])
})

test('lifecycle step kinds validate: disconnect, reconnect_from_cursor, advance_clock, set_app_state, expect_model, expect_notification', () => {
  const f = base()
  f.steps = [
    { kind: 'ws_open', role: 'client', conn: 'c' },
    { kind: 'disconnect', role: 'client', conn: 'c' },
    { kind: 'reconnect_from_cursor', role: 'client', conn: 'c' },
    { kind: 'reconnect_from_cursor', role: 'client', conn: 'c', cursor: 3 },
    { kind: 'advance_clock', role: 'client', ms: 30000 },
    { kind: 'set_app_state', role: 'client', app: 'background' },
    { kind: 'set_app_state', role: 'client', muted: true },
    { kind: 'expect_model', role: 'client', expect: { conversations: [{ id: 'c1', unread: { $type: 'integer' } }] } },
    { kind: 'expect_notification', role: 'client', expect: { decision: 'suppress', reason: 'muted' } },
  ]
  assert.deepEqual(validateFixture(f), [])
  const bad = (step) => { const g = base(); g.steps = [step]; return validateFixture(g) }
  assert.notDeepEqual(bad({ kind: 'advance_clock', role: 'client', ms: -1 }), [], 'negative ms')
  assert.notDeepEqual(bad({ kind: 'set_app_state', role: 'client' }), [], 'set_app_state needs app or muted')
  assert.notDeepEqual(bad({ kind: 'set_app_state', role: 'client', app: 'asleep' }), [], 'unknown app state')
  assert.notDeepEqual(bad({ kind: 'expect_model', role: 'client' }), [], 'expect_model needs expect')
  assert.notDeepEqual(bad({ kind: 'expect_model', role: 'agent', expect: {} }), [], 'expect_model is client-only')
  assert.notDeepEqual(bad({ kind: 'disconnect', role: 'client' }), [], 'disconnect needs conn')
})

test('a payload extract validates and rejects a missing samples list', () => {
  const ok = { type: 'ws.journal.text', surface: 'ws', protocol: 1, samples: [{ source: '04_x.json', frame: { kind: 'journal' } }] }
  assert.deepEqual(validatePayloadExtract(ok), [])
  assert.notDeepEqual(validatePayloadExtract({ ...ok, samples: [] }), [])
  assert.notDeepEqual(validatePayloadExtract({ type: ok.type, surface: 'ws', protocol: 1 }), [])
})
