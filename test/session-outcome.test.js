import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { openDb } from '../src/db.js'
import { createAgent, createUser } from '../src/auth.js'
import { append, upsertConversation } from '../src/journal.js'
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
  db.close()
  assert.doesNotThrow(() => openDb(dbPath).close())
  fs.rmSync(dir, { recursive: true, force: true })
})

test('session outcome is set once and child state never regresses through either writer', async (t) => {
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

  agent.send({
    op: 'convo_upsert', convo_id: 'child',
    session_state: 'running', session_outcome: 'failed',
  })
  await agent.waitFor((frame) => frame.kind === 'journal'
    && frame.convo_id === 'child'
    && frame.type === 'session_status'
    && frame.seq > completedStatus.seq
    && frame.payload.state === 'done')

  let child = s.db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='child'").get()
  assert.deepEqual(child, { session_state: 'done', session_outcome: 'completed' })

  append(s.db, {
    userId: user.id, convoId: 'child', sender: 'agent:outcome-agent',
    type: 'session_status', payload: { state: 'running' },
  })
  child = s.db.prepare("SELECT session_state, session_outcome FROM conversations WHERE id='child'").get()
  assert.deepEqual(child, { session_state: 'done', session_outcome: 'completed' })
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
})
