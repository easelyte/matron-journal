import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import {
  githubAccountView, saveGithubIdentity, markGithubStale, deleteGithubAccount, listGithubAccounts,
  createLinkFlow, takeLinkFlow, LINK_FLOW_TTL_MS,
  sealStoredTokens, updateGithubIdentity, createLinkConfirm, takeLinkConfirm,
} from '../src/github-accounts.js'
import { makeTokenBox, PLAIN_BOX, isSealed, tokenHash } from '../src/token-box.js'

const identity = { github_id: 42, login: 'DanBarker', scopes: ['github.com/matronhq'] }

test('saveGithubIdentity: creates, replaces orgs on re-save, and refuses an identity bound elsewhere', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const v = saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 't1', now: 1000 })
  assert.deepEqual(v, { host: 'github.com', login: 'DanBarker', orgs: ['github.com/matronhq'], state: 'ok', checked_at: 1000, linked_at: 1000 })
  assert.equal(githubAccountView(db, dan.id).token, undefined, 'the view never carries the token')
  const v2 = saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { ...identity, scopes: ['github.com/yearbooks'] }, token: 't2', now: 2000 })
  assert.deepEqual(v2.orgs, ['github.com/yearbooks']); assert.equal(v2.linked_at, 1000); assert.equal(v2.checked_at, 2000)
  assert.equal(db.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(dan.id).token, 't2')
  assert.throws(() => saveGithubIdentity(db, { userId: pat.id, host: 'github.com', identity, token: 't3', now: 3000 }), /github_conflict/)
  assert.equal(githubAccountView(db, pat.id), null)
  assert.deepEqual(listGithubAccounts(db), [{ user_id: dan.id, host: 'github.com', token: 't2', token_hash: tokenHash('t2') }])
  db.close()
})

test('stale and delete', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 't', now: 1 })
  markGithubStale(db, dan.id, { now: 5 })
  assert.equal(githubAccountView(db, dan.id).state, 'stale')
  assert.deepEqual(githubAccountView(db, dan.id).orgs, ['github.com/matronhq'], 'orgs are kept while stale')
  assert.equal(deleteGithubAccount(db, dan.id), true)
  assert.equal(deleteGithubAccount(db, dan.id), false)
  assert.equal(githubAccountView(db, dan.id), null)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_orgs').get().n, 0, 'orgs cascade')
  db.close()
})

test('link flows: single use, expire, looked up by id or state', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const f = createLinkFlow(db, { userId: dan.id, deviceId: 9, flow: 'device', deviceCode: 'dc', now: 1000 })
  assert.match(f.id, /^gl_[0-9a-f]{16}$/); assert.equal(f.expires_at, 1000 + LINK_FLOW_TTL_MS)
  const taken = takeLinkFlow(db, { id: f.id, now: 2000 })
  assert.equal(taken.device_code, 'dc'); assert.equal(taken.user_id, dan.id)
  assert.equal(takeLinkFlow(db, { id: f.id, now: 2000 }), null, 'single use')
  const w = createLinkFlow(db, { userId: dan.id, deviceId: 9, flow: 'web', state: 'st', now: 1000 })
  assert.equal(takeLinkFlow(db, { state: 'st', now: 1000 + LINK_FLOW_TTL_MS + 1 }), null, 'expired')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM github_link_flows WHERE id=?').get(w.id).n, 0, 'expired rows are deleted on read')
  db.close()
})

test('sealed storage: save writes enc1 + token_hash; guards match on the hash; confirm rows seal too; boot sealing upgrades plaintext rows', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw'); const pat = await createUser(db, 'pat', 'pw')
  const box = makeTokenBox('ab'.repeat(32))
  const identity = { github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 'gho_dan', now: 1, box })
  const row = db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(dan.id)
  assert.ok(isSealed(row.token)); assert.equal(row.token_hash, tokenHash('gho_dan'))
  assert.equal(box.open(listGithubAccounts(db)[0].token), 'gho_dan')
  assert.ok(updateGithubIdentity(db, { userId: dan.id, tokenHash: tokenHash('gho_dan'), identity: { ...identity, scopes: ['github.com/other'] }, now: 2 }))
  assert.deepEqual(githubAccountView(db, dan.id).orgs, ['github.com/other'])
  assert.equal(updateGithubIdentity(db, { userId: dan.id, tokenHash: tokenHash('stale-token'), identity, now: 3 }), null)
  markGithubStale(db, dan.id, { tokenHash: tokenHash('stale-token'), now: 4 })
  assert.equal(githubAccountView(db, dan.id).state, 'ok', 'a stale-mark for a token no longer held changes nothing')
  markGithubStale(db, dan.id, { tokenHash: tokenHash('gho_dan'), now: 5 })
  assert.equal(githubAccountView(db, dan.id).state, 'stale')

  const { nonce } = createLinkConfirm(db, { userId: pat.id, token: 'gho_pat', identity: { github_id: 2, login: 'pat', scopes: [] }, now: 1, box })
  assert.ok(isSealed(db.prepare('SELECT token FROM github_link_confirms').get().token))
  assert.equal(takeLinkConfirm(db, { nonce, now: 2, box }).token, 'gho_pat')

  // Plan A rows: plaintext token, no hash. Boot sealing fixes both.
  db.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, checked_at, linked_at) VALUES(?,?,?,?,?,'ok',1,1)").run(pat.id, 'github.com', 2, 'pat', 'gho_legacy')
  db.prepare('INSERT INTO github_link_confirms(id, user_id, nonce, token, identity_json, expires_at, created_at) VALUES(?,?,?,?,?,?,?)').run('gc_x', pat.id, 'ff'.repeat(16), 'gho_parked', '{}', 9e15, 1)
  const out = sealStoredTokens(db, box)
  assert.deepEqual(out, { sealed: 2, hashed: 1, unreadable: 0 })
  const legacy = db.prepare('SELECT token, token_hash FROM github_accounts WHERE user_id=?').get(pat.id)
  assert.ok(isSealed(legacy.token)); assert.equal(box.open(legacy.token), 'gho_legacy'); assert.equal(legacy.token_hash, tokenHash('gho_legacy'))
  assert.equal(box.open(db.prepare("SELECT token FROM github_link_confirms WHERE id='gc_x'").get().token), 'gho_parked')
  assert.deepEqual(sealStoredTokens(db, box), { sealed: 0, hashed: 0, unreadable: 0 }, 'idempotent')
  // Without a key, boot sealing only backfills hashes.
  const db2 = openDb(':memory:'); const sam = await createUser(db2, 'sam', 'pw')
  db2.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, checked_at, linked_at) VALUES(?,?,?,?,?,'ok',1,1)").run(sam.id, 'github.com', 3, 'sam', 'gho_sam')
  assert.deepEqual(sealStoredTokens(db2, PLAIN_BOX), { sealed: 0, hashed: 1, unreadable: 0 })
  assert.deepEqual(db2.prepare('SELECT token, token_hash FROM github_accounts').get(), { token: 'gho_sam', token_hash: tokenHash('gho_sam') })
})

test('sealStoredTokens: on a file-backed db the legacy plaintext is gone from the main file and the WAL, right after sealing and after close', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matron-seal-'))
  const dbPath = path.join(dir, 'journal.db')
  const db = openDb(dbPath)
  const pat = await createUser(db, 'pat', 'pw')
  const box = makeTokenBox('cc'.repeat(32))
  const legacy = 'gho_LEGACYPLAINTEXTMARKER' + 'z'.repeat(20)
  const parked = 'gho_PARKEDPLAINTEXTMARKER' + 'y'.repeat(20)
  const onDisk = () => Buffer.concat([dbPath, dbPath + '-wal'].filter((f) => fs.existsSync(f)).map((f) => fs.readFileSync(f)))
  // One row already checkpointed into the main file, one still only in the WAL:
  // both places a pre-encryption deployment can hold a plaintext token.
  db.prepare("INSERT INTO github_accounts(user_id, host, github_id, login, token, state, checked_at, linked_at) VALUES(?,?,?,?,?,'ok',1,1)").run(pat.id, 'github.com', 2, 'pat', legacy)
  db.pragma('wal_checkpoint(TRUNCATE)')
  db.prepare('INSERT INTO github_link_confirms(id, user_id, nonce, token, identity_json, expires_at, created_at) VALUES(?,?,?,?,?,?,?)').run('gc_x', pat.id, 'ff'.repeat(16), parked, '{}', 9e15, 1)
  assert.ok(fs.readFileSync(dbPath).includes(legacy), 'precondition: legacy token sits in the main file')
  assert.ok(fs.readFileSync(dbPath + '-wal').includes(parked), 'precondition: parked token sits in the WAL')

  assert.deepEqual(sealStoredTokens(db, box), { sealed: 2, hashed: 1, unreadable: 0 })
  let bytes = onDisk()
  assert.ok(!bytes.includes(legacy), 'legacy plaintext must not survive sealing on disk')
  assert.ok(!bytes.includes(parked), 'parked plaintext must not survive sealing on disk')
  db.close()
  bytes = onDisk()
  assert.ok(!bytes.includes(legacy) && !bytes.includes(parked), 'still absent after close (final checkpoint)')
  const db2 = openDb(dbPath)
  assert.equal(box.open(db2.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(pat.id).token), legacy, 'sealed value still opens')
  assert.equal(box.open(db2.prepare("SELECT token FROM github_link_confirms WHERE id='gc_x'").get().token), parked)
  db2.close()
  fs.rmSync(dir, { recursive: true, force: true })
})

test('sealed storage: a token sealed under a key this box does not hold is counted unreadable, not resealed', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const boxA = makeTokenBox('aa'.repeat(32))
  const boxB = makeTokenBox('bb'.repeat(32))
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity, token: 'gho_dan', now: 1, box: boxA })
  const sealedUnderA = db.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(dan.id).token
  assert.deepEqual(sealStoredTokens(db, boxB), { sealed: 0, hashed: 0, unreadable: 1 })
  // Untouched: still sealed under A, not silently resealed or corrupted.
  assert.equal(db.prepare('SELECT token FROM github_accounts WHERE user_id=?').get(dan.id).token, sealedUnderA)
})

test('takeLinkConfirm: a row sealed under a key this box does not hold throws token_unreadable, and the row is still consumed', async () => {
  const db = openDb(':memory:')
  const pat = await createUser(db, 'pat', 'pw')
  const boxA = makeTokenBox('aa'.repeat(32))
  const boxB = makeTokenBox('bb'.repeat(32))
  const { nonce } = createLinkConfirm(db, { userId: pat.id, token: 'gho_pat', identity: { github_id: 2, login: 'pat', scopes: [] }, now: 1, box: boxA })
  assert.throws(() => takeLinkConfirm(db, { nonce, now: 2, box: boxB }), /token_unreadable/)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM github_link_confirms').get().n, 0, 'the row is gone even though open() failed')
})
