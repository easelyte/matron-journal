import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { appendAgentIdempotent, AGENT_IDEM_TTL_MS } from '../src/agent-idem.js'
import { toEventShape, upsertConversation } from '../src/journal.js'
import { handleOp } from '../src/ws.js'

function seed(db) {
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
  db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(7,1,'agent','dev-a','ha',0)").run()
  upsertConversation(db, { id: 'target', ownerUserId: 1, title: 'Target' })
}

function peerAppendArgs(body = 'coordinate') {
  return {
    userId: 1,
    convoId: 'target',
    sender: 'agent:dev-a',
    type: 'peer_message',
    payload: { from_convo: 'from', from_name: 'Sender', from_kind: 'codex', body },
  }
}

function structuredLogCapture() {
  const entries = []
  return {
    entries,
    log: (line) => entries.push(JSON.parse(line)),
  }
}

test('agent idem dedupes inside 120s without populating permanent events.idem_key', () => {
  const db = openDb(':memory:')
  seed(db)
  const first = appendAgentIdempotent(db, {
    deviceId: 7, key: 'agent:7:same-content-hash', appendArgs: peerAppendArgs(), now: 1_000,
  })
  const duplicate = appendAgentIdempotent(db, {
    deviceId: 7, key: 'agent:7:same-content-hash', appendArgs: peerAppendArgs(), now: 2_000,
  })

  assert.deepEqual(duplicate, { seq: first.seq, duplicate: true })
  const rows = db.prepare('SELECT seq, idem_key FROM events').all()
  assert.deepEqual(rows, [{ seq: first.seq, idem_key: null }])
  assert.deepEqual(
    db.prepare('SELECT key, seq, expires_at FROM agent_idem').get(),
    { key: 'agent:7:same-content-hash', seq: first.seq, expires_at: 1_000 + AGENT_IDEM_TTL_MS },
  )

  const stored = db.prepare('SELECT * FROM events WHERE seq=?').get(first.seq)
  const wire = toEventShape({ ...stored, payload: JSON.parse(stored.payload) })
  assert.equal(Object.hasOwn(wire, 'idem_key'), false)
  db.close()
})

test('op:peer_message namespaces the key and returns the original seq without a second fan', async () => {
  const db = openDb(':memory:')
  seed(db)
  db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(8,1,'agent','dev-b','hb',0)").run()
  upsertConversation(db, {
    id: 'from', ownerUserId: 1, agentDeviceId: 7,
    title: 'Sender Session', agentKind: 'codex',
  })
  upsertConversation(db, { id: 'target', ownerUserId: 1, agentDeviceId: 8 })

  const frames = []
  const hub = { broadcastJournal: (_userId, frame) => frames.push(frame) }
  const conn = { kind: 'agent', userId: 1, deviceId: 7, name: 'dev-a', ws: { send() {} } }
  const msg = {
    op: 'peer_message', target_convo: 'target', from_convo: 'from',
    idem_key: 'same-content-hash', body: 'coordinate once',
  }
  let first
  let duplicate
  const capture = structuredLogCapture()
  first = await handleOp({ db, hub, conn, msg, log: capture.log })
  duplicate = await handleOp({ db, hub, conn, msg, log: capture.log })
  const logs = capture.entries

  assert.deepEqual(duplicate, { seq: first.seq, duplicate: true })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].seq, first.seq)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='peer_message'").get().n, 1)
  assert.equal(db.prepare('SELECT idem_key FROM events WHERE seq=?').get(first.seq).idem_key, null)
  assert.deepEqual(
    db.prepare('SELECT key, seq FROM agent_idem').get(),
    { key: 'agent:7:same-content-hash', seq: first.seq },
  )
  assert.deepEqual(logs.map(({ ts, ...entry }) => entry), [
    {
      type: 'peer_message_decision', decision: 'accept', reason: null,
      correlation_id: 'agent:7:same-content-hash', convo_id: 'target', seq: first.seq,
    },
    {
      type: 'peer_message_decision', decision: 'reject', reason: 'duplicate',
      correlation_id: 'agent:7:same-content-hash', convo_id: 'target', seq: first.seq,
    },
  ])
  assert.equal(logs.every(({ ts }) => !Number.isNaN(Date.parse(ts))), true)
  assert.equal(JSON.stringify(logs).includes(msg.body), false, 'info logs must not contain the body')
  db.close()
})

test('op:peer_message logs pre-append rejection reasons with correlation ids and no seq', async () => {
  const db = openDb(':memory:')
  seed(db)
  upsertConversation(db, {
    id: 'from', ownerUserId: 1, agentDeviceId: 7,
    title: 'Sender Session', agentKind: 'codex',
  })

  const frames = []
  const conn = {
    kind: 'agent', userId: 1, deviceId: 7, name: 'dev-a',
    ws: { send: (frame) => frames.push(JSON.parse(frame)) },
  }
  const body = 'BODY-MUST-NOT-APPEAR-IN-INFO-LOGS'
  const rejected = [
    {
      msg: {
        op: 'peer_message', target_convo: 'from', from_convo: 'from',
        idem_key: 'bad-request-hash', body,
      },
      reason: 'bad_request', correlation_id: 'agent:7:bad-request-hash', convo_id: 'from',
    },
    {
      msg: {
        op: 'peer_message', target_convo: 'target', from_convo: 'not-owned',
        idem_key: 'forbidden-hash', body,
      },
      reason: 'forbidden', correlation_id: 'agent:7:forbidden-hash', convo_id: 'target',
    },
    {
      msg: {
        op: 'peer_message', target_convo: 'missing', from_convo: 'from',
        idem_key: 'not-found-hash', body,
      },
      reason: 'not_found', correlation_id: 'agent:7:not-found-hash', convo_id: 'missing',
    },
  ]

  const capture = structuredLogCapture()
  for (const { msg } of rejected) {
    await handleOp({ db, hub: {}, conn, msg, log: capture.log })
  }
  const logs = capture.entries

  assert.deepEqual(
    logs.map(({ ts, ...entry }) => entry),
    rejected.map(({ reason, correlation_id, convo_id }) => ({
      type: 'peer_message_decision', decision: 'reject', reason, correlation_id, convo_id,
    })),
  )
  assert.equal(logs.every(({ ts }) => !Number.isNaN(Date.parse(ts))), true)
  assert.equal(logs.every((entry) => !Object.hasOwn(entry, 'seq')), true)
  assert.equal(JSON.stringify(logs).includes(body), false, 'info logs must not contain the body')
  assert.deepEqual(frames.map(({ code }) => code), rejected.map(({ reason }) => reason))
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='peer_message'").get().n, 0)
  db.close()
})

test('agent idem allows the same key after expiry and distinguishes different logical sends', () => {
  const db = openDb(':memory:')
  seed(db)
  const first = appendAgentIdempotent(db, {
    deviceId: 7, key: 'agent:7:body-a-hash', appendArgs: peerAppendArgs('body a'), now: 10,
  })
  const different = appendAgentIdempotent(db, {
    deviceId: 7, key: 'agent:7:body-b-hash', appendArgs: peerAppendArgs('body b'), now: 11,
  })
  const afterWindow = appendAgentIdempotent(db, {
    deviceId: 7, key: 'agent:7:body-a-hash', appendArgs: peerAppendArgs('body a'), now: 10 + AGENT_IDEM_TTL_MS,
  })

  assert.equal(first.duplicate, false)
  assert.equal(different.duplicate, false)
  assert.equal(afterWindow.duplicate, false)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 3)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n, 2)
  db.close()
})

test('agent idem survives a database close and reopen inside the live window', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-agent-idem-restart-'))
  const dbPath = path.join(dir, 'journal.db')
  let db = openDb(dbPath)
  try {
    seed(db)
    const first = appendAgentIdempotent(db, {
      deviceId: 7, key: 'agent:7:restart-hash', appendArgs: peerAppendArgs(), now: 5_000,
    })
    db.close()
    db = openDb(dbPath)

    const duplicate = appendAgentIdempotent(db, {
      deviceId: 7, key: 'agent:7:restart-hash', appendArgs: peerAppendArgs(), now: 6_000,
    })
    assert.deepEqual(duplicate, { seq: first.seq, duplicate: true })
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1)
  } finally {
    if (db.open) db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('failure between append and dedup insert rolls back both; retransmit persists once', () => {
  const db = openDb(':memory:')
  seed(db)
  db.exec(`
    CREATE TRIGGER fail_agent_idem_insert BEFORE INSERT ON agent_idem
    BEGIN SELECT RAISE(ABORT, 'simulated crash before dedup write'); END;
  `)

  assert.throws(
    () => appendAgentIdempotent(db, {
      deviceId: 7, key: 'agent:7:crash-hash', appendArgs: peerAppendArgs(), now: 1_000,
    }),
    /simulated crash/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n, 0)

  db.exec('DROP TRIGGER fail_agent_idem_insert')
  const retransmit = appendAgentIdempotent(db, {
    deviceId: 7, key: 'agent:7:crash-hash', appendArgs: peerAppendArgs(), now: 2_000,
  })
  const duplicate = appendAgentIdempotent(db, {
    deviceId: 7, key: 'agent:7:crash-hash', appendArgs: peerAppendArgs(), now: 3_000,
  })
  assert.deepEqual(duplicate, { seq: retransmit.seq, duplicate: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1)
  db.close()
})

test('revoking a device cascades its dedupe rows so a reused device id can send', () => {
  const db = openDb(':memory:')
  seed(db)
  const first = appendAgentIdempotent(db, {
    deviceId: 7,
    key: 'agent:7:reused-key',
    appendArgs: peerAppendArgs('first incarnation'),
    now: 1_000,
  })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n, 1)

  db.prepare('DELETE FROM devices WHERE id=7').run()
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n, 0)
  db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(7,1,'agent','replacement','hb',1)").run()

  const replacement = appendAgentIdempotent(db, {
    deviceId: 7,
    key: 'agent:7:reused-key',
    appendArgs: peerAppendArgs('replacement incarnation'),
    now: 2_000,
  })
  assert.equal(replacement.duplicate, false)
  assert.notEqual(replacement.seq, first.seq)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 2)
  db.close()
})

test('openDb safely migrates legacy agent_idem rows and binds live rows to devices', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-agent-idem-migrate-'))
  const dbPath = path.join(dir, 'journal.db')
  const legacy = new Database(dbPath)
  legacy.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE devices(
      id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
      kind TEXT NOT NULL CHECK(kind IN ('client','agent')), name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE, cursor INTEGER NOT NULL DEFAULT 0,
      apns_token TEXT, created_at INTEGER NOT NULL, last_seen_at INTEGER
    );
    CREATE TABLE agent_idem(key TEXT PRIMARY KEY, seq INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    INSERT INTO users VALUES(1, 'dan', 'x', 0);
    INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(7,1,'agent','dev-a','ha',0);
    INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(10,1,'agent','replacement','hb',900000);
    INSERT INTO agent_idem VALUES('agent:7:keep', 3, 999999);
    INSERT INTO agent_idem VALUES('agent:99:revoked', 4, 999999);
    INSERT INTO agent_idem VALUES('agent:10:prior-incarnation', 5, 999999);
  `)
  legacy.close()

  let db
  try {
    db = openDb(dbPath)
    assert.deepEqual(
      db.prepare('SELECT key, device_id, seq FROM agent_idem').all(),
      [{ key: 'agent:7:keep', device_id: 7, seq: 3 }],
    )
    const fk = db.prepare('PRAGMA foreign_key_list(agent_idem)').all()
      .find((row) => row.from === 'device_id')
    assert.equal(fk?.table, 'devices')
    assert.equal(fk?.on_delete, 'CASCADE')
    db.prepare('DELETE FROM devices WHERE id=7').run()
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n, 0)
  } finally {
    if (db?.open) db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent same-key arrivals on separate DB connections serialize to one event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-agent-idem-concurrent-'))
  const dbPath = path.join(dir, 'journal.db')
  const setupDb = openDb(dbPath)
  seed(setupDb)
  setupDb.close()

  const gateBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2)
  const gate = new Int32Array(gateBuffer)
  const workerSource = `
    const { parentPort, workerData } = require('node:worker_threads')
    ;(async () => {
      const { openDb } = await import(workerData.dbModule)
      const { appendAgentIdempotent } = await import(workerData.idemModule)
      const db = openDb(workerData.dbPath)
      const gate = new Int32Array(workerData.gateBuffer)
      parentPort.postMessage({ ready: true })
      Atomics.wait(gate, 1, 0)
      let result
      try {
        result = appendAgentIdempotent(db, {
          deviceId: 7,
          key: 'agent:7:concurrent-hash',
          appendArgs: workerData.appendArgs,
          now: 10_000,
        })
      } finally {
        db.close()
      }
      parentPort.postMessage({ result })
    })().catch((error) => parentPort.postMessage({ error: error.stack || String(error) }))
  `
  const workerData = {
    dbPath,
    gateBuffer,
    dbModule: new URL('../src/db.js', import.meta.url).href,
    idemModule: new URL('../src/agent-idem.js', import.meta.url).href,
    appendArgs: peerAppendArgs(),
  }
  const workers = [
    new Worker(workerSource, { eval: true, workerData }),
    new Worker(workerSource, { eval: true, workerData }),
  ]
  const workerExits = workers.map((worker) => new Promise((resolve) => worker.on('exit', resolve)))

  try {
    const controls = workers.map((worker) => {
      let resolveReady
      let rejectReady
      let resolveResult
      let rejectResult
      const ready = new Promise((resolve, reject) => {
        resolveReady = resolve
        rejectReady = reject
      })
      const result = new Promise((resolve, reject) => {
        resolveResult = resolve
        rejectResult = reject
      })
      const rejectBoth = (error) => {
        rejectReady(error)
        rejectResult(error)
      }
      worker.on('message', (message) => {
        if (message.ready) resolveReady()
        else if (message.error) rejectBoth(new Error(message.error))
        else if (message.result) resolveResult(message.result)
      })
      worker.on('error', rejectBoth)
      return { ready, result }
    })
    await Promise.all(controls.map((control) => control.ready))
    Atomics.store(gate, 1, 1)
    Atomics.notify(gate, 1, workers.length)
    const arrivals = await Promise.all(controls.map((control) => control.result))
    await Promise.all(workerExits)

    assert.equal(arrivals.filter((r) => !r.duplicate).length, 1)
    assert.equal(arrivals.filter((r) => r.duplicate).length, 1)
    assert.equal(new Set(arrivals.map((r) => r.seq)).size, 1)
    const verifyDb = openDb(dbPath)
    assert.equal(verifyDb.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1)
    verifyDb.close()
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()))
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
