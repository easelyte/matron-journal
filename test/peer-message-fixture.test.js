import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { appendAgentIdempotent } from '../src/agent-idem.js'
import { openDb } from '../src/db.js'
import { toEventShape, upsertConversation } from '../src/journal.js'
import { handleOp } from '../src/ws.js'

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
    db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(7,1,'agent','sender-device','ha',0)").run()
    upsertConversation(db, { id: 'target', ownerUserId: 1, title: 'Target' })
    const result = appendAgentIdempotent(db, {
      deviceId: 7,
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
    for (const key of PAYLOAD_KEYS.filter((key) => key !== 'from_kind')) {
      assert.equal(typeof wire.payload[key], 'string')
    }
    assert.equal(wire.payload.from_kind === null || typeof wire.payload.from_kind === 'string', true)
  } finally {
    db.close()
  }
})

test('handleOp emits the canonical peer_message shape with nullable legacy from_kind', async () => {
  const db = openDb(':memory:')
  try {
    db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
    db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(7,1,'agent','sender-device','ha',0)").run()
    db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(8,1,'agent','target-device','hb',0)").run()
    upsertConversation(db, {
      id: 'source', ownerUserId: 1, agentDeviceId: 7, title: 'Legacy Sender',
    })
    upsertConversation(db, {
      id: 'target', ownerUserId: 1, agentDeviceId: 8, title: 'Target',
    })

    await handleOp({
      db,
      hub: { broadcastJournal() {} },
      conn: { kind: 'agent', userId: 1, deviceId: 7, name: 'sender-device', ws: { send() {} } },
      msg: {
        op: 'peer_message', target_convo: 'target', from_convo: 'source',
        idem_key: 'legacy-null-kind', body: 'Coordinate safely.',
      },
    })

    const stored = db.prepare("SELECT * FROM events WHERE type='peer_message'").get()
    const wire = toEventShape({ ...stored, payload: JSON.parse(stored.payload) })
    assert.deepEqual(keys(wire), EVENT_KEYS)
    assert.deepEqual(keys(wire.payload), PAYLOAD_KEYS)
    assert.equal(wire.payload.from_kind, null)
    for (const key of PAYLOAD_KEYS.filter((key) => key !== 'from_kind')) {
      assert.equal(typeof wire.payload[key], 'string')
    }
  } finally {
    db.close()
  }
})

// Canonical PRIORITY variant: a peer_message with priority:true carries a 5th payload key.
// Bridge and web vendor this file verbatim — the same cross-repo byte-parity gate as the base
// fixture — so the supported 5-key wire shape is represented by executable contract evidence.
const priorityFixturePath = fileURLToPath(new URL('./fixtures/peer_message.priority.fixture.json', import.meta.url))
const priorityFixture = JSON.parse(fs.readFileSync(priorityFixturePath, 'utf8'))
const PRIORITY_PAYLOAD_KEYS = ['body', 'from_convo', 'from_kind', 'from_name', 'priority']

test('canonical priority peer_message fixture matches the real handleOp wire contract exactly', async () => {
  assert.deepEqual(keys(priorityFixture), ['event', 'fixtureVersion'])
  assert.deepEqual(keys(priorityFixture.event), EVENT_KEYS)
  assert.deepEqual(keys(priorityFixture.event.payload), PRIORITY_PAYLOAD_KEYS)
  assert.equal(priorityFixture.event.payload.priority, true)
  assert.equal(priorityFixture.event.type, 'peer_message')
  assert.equal(priorityFixture.fixtureVersion, fixtureVersion(priorityFixture.event))
  assert.equal(JSON.stringify(priorityFixture).includes('idem_key'), false)

  const db = openDb(':memory:')
  try {
    db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
    db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(7,1,'agent','sender-device','ha',0)").run()
    db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(8,1,'agent','target-device','hb',0)").run()
    upsertConversation(db, { id: 'source', ownerUserId: 1, agentDeviceId: 7, title: 'Sender Session', agentKind: 'codex' })
    upsertConversation(db, { id: 'target', ownerUserId: 1, agentDeviceId: 8, title: 'Target' })

    await handleOp({
      db,
      hub: { broadcastJournal() {} },
      conn: { kind: 'agent', userId: 1, deviceId: 7, name: 'sender-device', ws: { send() {} } },
      msg: {
        op: 'peer_message', target_convo: 'target', from_convo: 'source',
        idem_key: 'priority-shape', body: 'Coordinate on the release checklist.', priority: true,
      },
    })

    const stored = db.prepare("SELECT * FROM events WHERE type='peer_message'").get()
    const wire = toEventShape({ ...stored, payload: JSON.parse(stored.payload) })
    // The real producer emits exactly the canonical priority shape — 5 payload keys, priority true.
    assert.deepEqual(keys(wire), EVENT_KEYS)
    assert.deepEqual(keys(wire.payload), PRIORITY_PAYLOAD_KEYS)
    assert.equal(wire.payload.priority, true)
    assert.equal(wire.payload.from_kind, 'codex')
  } finally {
    db.close()
  }
})
