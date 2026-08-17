import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'
import { openDb } from '../src/db.js'
import { appendAgentIdempotent, AGENT_IDEM_TTL_MS } from '../src/agent-idem.js'
import { toEventShape, upsertConversation } from '../src/journal.js'
import { handleOp } from '../src/ws.js'

function seed(db) {
  db.prepare("INSERT INTO users(id, name, password_hash, created_at) VALUES(1,'dan','x',0)").run()
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

test('agent idem dedupes inside 120s without populating permanent events.idem_key', () => {
  const db = openDb(':memory:')
  seed(db)
  const first = appendAgentIdempotent(db, {
    key: 'agent:7:same-content-hash', appendArgs: peerAppendArgs(), now: 1_000,
  })
  const duplicate = appendAgentIdempotent(db, {
    key: 'agent:7:same-content-hash', appendArgs: peerAppendArgs(), now: 2_000,
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
  db.prepare("INSERT INTO devices(id,user_id,kind,name,token_hash,created_at) VALUES(7,1,'agent','dev-a','ha',0)").run()
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
  const first = await handleOp({ db, hub, conn, msg })
  const duplicate = await handleOp({ db, hub, conn, msg })

  assert.deepEqual(duplicate, { seq: first.seq, duplicate: true })
  assert.equal(frames.length, 1)
  assert.equal(frames[0].seq, first.seq)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='peer_message'").get().n, 1)
  assert.equal(db.prepare('SELECT idem_key FROM events WHERE seq=?').get(first.seq).idem_key, null)
  assert.deepEqual(
    db.prepare('SELECT key, seq FROM agent_idem').get(),
    { key: 'agent:7:same-content-hash', seq: first.seq },
  )
  db.close()
})

test('agent idem allows the same key after expiry and distinguishes different logical sends', () => {
  const db = openDb(':memory:')
  seed(db)
  const first = appendAgentIdempotent(db, {
    key: 'agent:7:body-a-hash', appendArgs: peerAppendArgs('body a'), now: 10,
  })
  const different = appendAgentIdempotent(db, {
    key: 'agent:7:body-b-hash', appendArgs: peerAppendArgs('body b'), now: 11,
  })
  const afterWindow = appendAgentIdempotent(db, {
    key: 'agent:7:body-a-hash', appendArgs: peerAppendArgs('body a'), now: 10 + AGENT_IDEM_TTL_MS,
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
      key: 'agent:7:restart-hash', appendArgs: peerAppendArgs(), now: 5_000,
    })
    db.close()
    db = openDb(dbPath)

    const duplicate = appendAgentIdempotent(db, {
      key: 'agent:7:restart-hash', appendArgs: peerAppendArgs(), now: 6_000,
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
      key: 'agent:7:crash-hash', appendArgs: peerAppendArgs(), now: 1_000,
    }),
    /simulated crash/,
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM agent_idem').get().n, 0)

  db.exec('DROP TRIGGER fail_agent_idem_insert')
  const retransmit = appendAgentIdempotent(db, {
    key: 'agent:7:crash-hash', appendArgs: peerAppendArgs(), now: 2_000,
  })
  const duplicate = appendAgentIdempotent(db, {
    key: 'agent:7:crash-hash', appendArgs: peerAppendArgs(), now: 3_000,
  })
  assert.deepEqual(duplicate, { seq: retransmit.seq, duplicate: true })
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 1)
  db.close()
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
