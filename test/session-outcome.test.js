import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { createAgent, createUser } from '../src/auth.js'
import { append, eventsAfter, snapshot, upsertConversation } from '../src/journal.js'
import { makeWsClient, startTestServer } from './helpers.js'

test('openDb adds session_outcome to an existing database idempotently', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-outcome-migration-'))
  const dbPath = path.join(dir, 'pre-migration.db')
  const raw = new Database(dbPath)
  raw.exec(`
    CREATE TABLE conversations(
      id TEXT PRIMARY KEY,
      owner_user_id INTEGER NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      session_state TEXT NOT NULL DEFAULT 'running',
      last_seq INTEGER NOT NULL DEFAULT 0,
      unread_count INTEGER NOT NULL DEFAULT 0,
      snippet TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
  `)
  raw.prepare("INSERT INTO conversations(id, owner_user_id, title, created_at) VALUES('legacy',1,'old',0)").run()
  raw.close()

  const db = openDb(dbPath)
  const columns = db.prepare('PRAGMA table_info(conversations)').all()
    .filter((column) => column.name === 'session_outcome')
  assert.equal(columns.length, 1)
  assert.equal(db.prepare("SELECT session_outcome FROM conversations WHERE id='legacy'").get().session_outcome, null)
  assert.throws(
    () => db.prepare("UPDATE conversations SET session_outcome='malformed' WHERE id='legacy'").run(),
    /CHECK constraint failed/
  )
  assert.throws(
    () => db.prepare("UPDATE conversations SET session_state='running', session_outcome='completed' WHERE id='legacy'").run(),
    /CHECK constraint failed/
  )
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('session outcome is set once and every done child regression is blocked through either writer', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const user = await createUser(s.db, 'outcome-user', 'pw')
  const agentCredentials = createAgent(s.db, user.id, 'outcome-agent')
  const agent = await makeWsClient(s.base, { token: agentCredentials.token, cursor: null })
  t.after(() => agent.close())
  await agent.waitFor((frame) => frame.op === 'hello_ok')

  agent.send({
    op: 'convo_upsert', convo_id: 'child', parent_convo_id: 'parent',
    session_state: 'done', session_outcome: 'completed',
  })
  const completedStatus = await agent.waitFor((frame) => frame.kind === 'journal'
    && frame.convo_id === 'child'
    && frame.type === 'session_status'
    && frame.payload.session_outcome === 'completed')

  let lastStatusSeq = completedStatus.seq
  for (const state of ['running', 'waiting', 'archived']) {
    agent.send({ op: 'convo_upsert', convo_id: 'child', session_state: state })
    const status = await agent.waitFor((frame) => frame.kind === 'journal'
      && frame.convo_id === 'child'
      && frame.type === 'session_status'
      && frame.seq > lastStatusSeq
      && frame.payload.state === 'done')
    lastStatusSeq = status.seq
    let child = s.db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='child'").get()
    assert.deepEqual(child, { session_state: 'done', session_outcome: 'completed' })

    append(s.db, {
      userId: user.id, convoId: 'child', sender: 'agent:outcome-agent',
      type: 'session_status', payload: { state },
    })
    child = s.db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='child'").get()
    assert.deepEqual(child, { session_state: 'done', session_outcome: 'completed' })
  }

  agent.send({
    op: 'convo_upsert', convo_id: 'child',
    session_state: 'done', session_outcome: 'failed',
  })
  await agent.waitFor((frame) => frame.kind === 'journal'
    && frame.convo_id === 'child'
    && frame.type === 'session_status'
    && frame.seq > lastStatusSeq)
  assert.deepEqual(
    s.db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='child'").get(),
    { session_state: 'done', session_outcome: 'completed' }
  )
})

test('a done top-level conversation can reopen to running', async () => {
  const db = openDb(':memory:')
  const user = await createUser(db, 'top-level-user', 'pw')
  upsertConversation(db, { id: 'top', ownerUserId: user.id, sessionState: 'done' })
  upsertConversation(db, { id: 'top', ownerUserId: user.id, sessionState: 'running' })
  assert.equal(db.prepare("SELECT session_state FROM conversations WHERE id='top'").get().session_state, 'running')

  append(db, {
    userId: user.id, convoId: 'top', sender: 'agent:test',
    type: 'session_status', payload: { state: 'done' },
  })
  append(db, {
    userId: user.id, convoId: 'top', sender: 'agent:test',
    type: 'session_status', payload: { state: 'running' },
  })
  assert.equal(db.prepare("SELECT session_state FROM conversations WHERE id='top'").get().session_state, 'running')
  db.close()
})

test('an outcome locks a top-level conversation at done through both writers', async () => {
  const db = openDb(':memory:')
  const user = await createUser(db, 'top-level-outcome-user', 'pw')
  upsertConversation(db, {
    id: 'top-outcome', ownerUserId: user.id,
    sessionState: 'done', sessionOutcome: 'completed',
  })

  upsertConversation(db, {
    id: 'top-outcome', ownerUserId: user.id, sessionState: 'running',
  })
  assert.deepEqual(
    db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='top-outcome'").get(),
    { session_state: 'done', session_outcome: 'completed' },
  )

  append(db, {
    userId: user.id, convoId: 'top-outcome', sender: 'agent:test',
    type: 'session_status', payload: { state: 'running' },
  })
  assert.deepEqual(
    db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='top-outcome'").get(),
    { session_state: 'done', session_outcome: 'completed' },
  )
  db.close()
})

test('convo_upsert validates outcome, broadcasts the persisted value, and snapshot replays it', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const user = await createUser(s.db, 'wire-user', 'pw')
  const agentCredentials = createAgent(s.db, user.id, 'wire-agent')
  const login = await s.http('/login', {
    method: 'POST', body: { username: 'wire-user', password: 'pw', device_name: 'wire-client' },
  })
  const agent = await makeWsClient(s.base, { token: agentCredentials.token, cursor: null })
  const client = await makeWsClient(s.base, { token: login.json.token, cursor: 0 })
  t.after(() => { agent.close(); client.close() })
  await agent.waitFor((frame) => frame.op === 'hello_ok')
  await client.waitFor((frame) => frame.op === 'hello_ok')

  agent.send({
    op: 'convo_upsert', convo_id: 'wire-child', parent_convo_id: 'wire-parent',
    session_state: 'done', session_outcome: 'interrupted',
  })
  const status = await client.waitFor((frame) => frame.kind === 'journal'
    && frame.convo_id === 'wire-child'
    && frame.type === 'session_status')
  assert.deepEqual(status.payload, { state: 'done', session_outcome: 'interrupted' })

  agent.send({
    op: 'convo_upsert', convo_id: 'wire-child',
    session_state: 'done', session_outcome: 'failed',
  })
  const statuses = () => client.frames.filter((frame) => frame.kind === 'journal'
    && frame.convo_id === 'wire-child'
    && frame.type === 'session_status')
  await client.waitFor(() => statuses().length === 2)
  assert.equal(statuses()[1].payload.session_outcome, 'interrupted')

  for (const accepted of [null, undefined]) {
    const frame = { op: 'convo_upsert', convo_id: `accepted-${String(accepted)}` }
    if (accepted === null) frame.session_outcome = null
    agent.send(frame)
  }

  agent.send({ op: 'convo_upsert', convo_id: 'rejected', session_outcome: 'unknown' })
  const error = await agent.waitFor((frame) => frame.kind === 'control'
    && frame.op === 'error'
    && frame.code === 'bad_request'
    && frame.ref === 'convo_upsert')
  assert.equal(error.detail, 'bad session_outcome')
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id='rejected'").get().n, 0)

  const snapshot = await s.http('/snapshot', { token: login.json.token })
  assert.equal(snapshot.json.conversations.find((convo) => convo.id === 'wire-child').session_outcome, 'interrupted')
  assert.deepEqual(snapshot.json.capabilities, ['session_outcome'])
})

test('a non-terminal outcome is rejected without latching and the later terminal outcome wins', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const user = await createUser(s.db, 'lifecycle-user', 'pw')
  const credentials = createAgent(s.db, user.id, 'lifecycle-agent')
  upsertConversation(s.db, {
    id: 'running-child', ownerUserId: user.id, parentConvoId: 'parent', sessionState: 'running',
  })
  const agent = await makeWsClient(s.base, { token: credentials.token, cursor: null })
  t.after(() => agent.close())
  await agent.waitFor((frame) => frame.op === 'hello_ok')

  agent.send({
    op: 'convo_upsert', convo_id: 'running-child',
    session_state: 'running', session_outcome: 'completed',
  })
  const error = await agent.waitFor((frame) => frame.kind === 'control'
    && frame.op === 'error'
    && frame.ref === 'convo_upsert')
  assert.equal(error.detail, 'session_outcome requires terminal session_state')
  assert.equal(s.db.prepare("SELECT session_outcome FROM conversations WHERE id='running-child'").get().session_outcome, null)

  agent.send({
    op: 'convo_upsert', convo_id: 'running-child',
    session_state: 'done', session_outcome: 'failed',
  })
  await agent.waitFor((frame) => frame.kind === 'journal'
    && frame.convo_id === 'running-child'
    && frame.type === 'session_status'
    && frame.payload.session_outcome === 'failed')
  assert.deepEqual(
    s.db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='running-child'").get(),
    { session_state: 'done', session_outcome: 'failed' }
  )
})

test('an outcome-only update on a done child is durable and advances replay sequence', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const user = await createUser(s.db, 'outcome-only-user', 'pw')
  const credentials = createAgent(s.db, user.id, 'outcome-only-agent')
  upsertConversation(s.db, {
    id: 'done-child', ownerUserId: user.id, parentConvoId: 'parent', sessionState: 'done',
  })
  const before = snapshot(s.db, user.id).seq
  const agent = await makeWsClient(s.base, { token: credentials.token, cursor: null })
  t.after(() => agent.close())
  await agent.waitFor((frame) => frame.op === 'hello_ok')

  agent.send({ op: 'convo_upsert', convo_id: 'done-child', session_outcome: 'interrupted' })
  const status = await agent.waitFor((frame) => frame.kind === 'journal'
    && frame.convo_id === 'done-child'
    && frame.type === 'session_status'
    && frame.payload.session_outcome === 'interrupted')
  assert.ok(status.seq > before)
  const replay = eventsAfter(s.db, user.id, before)
  assert.equal(replay.length, 1)
  assert.equal(replay[0].seq, status.seq)
  assert.deepEqual(replay[0].payload, { state: 'done', session_outcome: 'interrupted' })
})

test('convo_upsert rolls back lifecycle metadata when its generated event cannot commit', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  const user = await createUser(s.db, 'atomic-user', 'pw')
  const credentials = createAgent(s.db, user.id, 'atomic-agent')
  const agent = await makeWsClient(s.base, { token: credentials.token, cursor: null })
  t.after(() => agent.close())
  await agent.waitFor((frame) => frame.op === 'hello_ok')
  s.db.exec(`
    CREATE TRIGGER reject_session_status BEFORE INSERT ON events
    WHEN NEW.type='session_status'
    BEGIN SELECT RAISE(ABORT, 'forced event failure'); END;
  `)

  agent.send({
    op: 'convo_upsert', convo_id: 'atomic-child', parent_convo_id: 'parent',
    session_state: 'done', session_outcome: 'completed',
  })
  await agent.waitFor((frame) => frame.kind === 'control' && frame.op === 'error')
  assert.equal(s.db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE id='atomic-child'").get().n, 0)
  assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM events').get().n, 0)
  assert.equal(snapshot(s.db, user.id).seq, 0)
})

test('the persistence primitive rejects malformed outcomes and non-terminal lifecycle tuples', async () => {
  const db = openDb(':memory:')
  const user = await createUser(db, 'primitive-user', 'pw')
  assert.throws(
    () => upsertConversation(db, {
      id: 'bad-enum', ownerUserId: user.id, sessionState: 'done', sessionOutcome: 'malformed',
    }),
    /invalid session_outcome/
  )
  assert.throws(
    () => upsertConversation(db, {
      id: 'bad-tuple', ownerUserId: user.id, sessionState: 'running', sessionOutcome: 'completed',
    }),
    /requires terminal session_state/
  )
  assert.throws(
    () => db.prepare(`
      INSERT INTO conversations(id, owner_user_id, session_state, session_outcome, created_at)
      VALUES('direct-bad-tuple', ?, 'running', 'completed', 0)
    `).run(user.id),
    /CHECK constraint failed/
  )
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM conversations').get().n, 0)
  db.close()
})
