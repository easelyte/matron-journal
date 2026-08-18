import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { appendAgentIdempotent } from '../src/agent-idem.js'
import { openDb } from '../src/db.js'
import { toEventShape, upsertConversation } from '../src/journal.js'

// Canonical producer-owned contract. Bridge and web vendor this file verbatim;
// their cross-repo byte-parity gate is intentionally owned by T-6.4.
const fixturePath = fileURLToPath(new URL('./fixtures/peer_message.fixture.json', import.meta.url))
const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))

const EVENT_KEYS = ['convo_id', 'payload', 'sender', 'seq', 'ts', 'type']
const PAYLOAD_KEYS = ['body', 'from_convo', 'from_kind', 'from_name']

function keys(value) {
  return Object.keys(value).sort()
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(keys(value).map((key) => [key, canonical(value[key])]))
  }
  return value
}

function fixtureVersion(event) {
  const shape = JSON.stringify(canonical(event))
  return `sha256:${createHash('sha256').update(shape).digest('hex')}`
}

test('canonical peer_message fixture matches the real toEventShape wire contract exactly', () => {
  assert.deepEqual(keys(fixture), ['event', 'fixtureVersion'])
  assert.deepEqual(keys(fixture.event), EVENT_KEYS)
  assert.deepEqual(keys(fixture.event.payload), PAYLOAD_KEYS)
  assert.equal(fixture.event.type, 'peer_message')
  assert.equal(fixture.fixtureVersion, fixtureVersion(fixture.event))
  assert.equal(JSON.stringify(fixture).includes('idem_key'), false)

  const db = openDb(':memory:')
  try {
    db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
    upsertConversation(db, { id: 'target', ownerUserId: 1, title: 'Target' })
    const result = appendAgentIdempotent(db, {
      key: 'agent:7:fixture-shape',
      now: 1_000,
      appendArgs: {
        userId: 1,
        convoId: 'target',
        sender: 'agent:sender-device',
        type: 'peer_message',
        payload: {
          from_convo: 'source',
          from_name: 'Sender Session',
          from_kind: 'codex',
          body: 'Coordinate on the release checklist.',
        },
      },
    })
    const stored = db.prepare('SELECT * FROM events WHERE seq=?').get(result.seq)
    const wire = toEventShape({ ...stored, payload: JSON.parse(stored.payload) })

    assert.deepEqual(keys(wire), keys(fixture.event))
    assert.deepEqual(keys(wire.payload), keys(fixture.event.payload))
    assert.equal(Object.hasOwn(wire, 'idem_key'), false)
    assert.equal(Object.hasOwn(wire.payload, 'idem_key'), false)
    assert.equal(Number.isInteger(wire.seq), true)
    assert.equal(typeof wire.convo_id, 'string')
    assert.equal(typeof wire.ts, 'number')
    assert.equal(typeof wire.sender, 'string')
    assert.equal(wire.type, 'peer_message')
    for (const key of PAYLOAD_KEYS) assert.equal(typeof wire.payload[key], 'string')
  } finally {
    db.close()
  }
})
