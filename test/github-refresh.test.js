import test from 'node:test'
import assert from 'node:assert/strict'
import { openDb } from '../src/db.js'
import { createUser } from '../src/auth.js'
import { saveGithubIdentity, githubAccountView } from '../src/github-accounts.js'
import { GithubError } from '../src/github.js'
import { runGithubRefresh, scheduleGithubRefresh } from '../src/github-refresh.js'

test('runGithubRefresh: refreshes every linked account, marks refused tokens stale, keeps unreachable ones', async () => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  const pat = await createUser(db, 'pat', 'pw')
  const sam = await createUser(db, 'sam', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 1, login: 'dan', scopes: ['github.com/a'] }, token: 'tdan', now: 1 })
  saveGithubIdentity(db, { userId: pat.id, host: 'github.com', identity: { github_id: 2, login: 'pat', scopes: ['github.com/a'] }, token: 'tpat', now: 1 })
  saveGithubIdentity(db, { userId: sam.id, host: 'github.com', identity: { github_id: 3, login: 'sam', scopes: ['github.com/a'] }, token: 'tsam', now: 1 })
  const github = {
    host: 'github.com', enabled: true,
    fetchIdentity: async (token) => {
      if (token === 'tdan') return { github_id: 1, login: 'dan', scopes: ['github.com/b'] }
      if (token === 'tpat') throw new GithubError('unauthorized')
      throw new GithubError('unreachable')
    },
  }
  const lines = []
  const r = await runGithubRefresh(db, github, { now: 500, log: (l) => lines.push(l) })
  assert.deepEqual(r, { refreshed: 1, stale: 1, unchanged: 1 })
  assert.deepEqual(githubAccountView(db, dan.id).orgs, ['github.com/b'])
  assert.equal(githubAccountView(db, pat.id).state, 'stale')
  assert.equal(githubAccountView(db, sam.id).state, 'ok'); assert.equal(githubAccountView(db, sam.id).checked_at, 1)
  assert.ok(lines.some((l) => /stale/.test(l)))
  assert.ok(!lines.some((l) => /tdan|tpat|tsam/.test(l)), 'tokens never logged')
  db.close()
})

test('scheduleGithubRefresh is single-flight: a run still in progress makes the next tick skip, not overlap', async (t) => {
  const db = openDb(':memory:')
  const dan = await createUser(db, 'dan', 'pw')
  saveGithubIdentity(db, { userId: dan.id, host: 'github.com', identity: { github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }, token: 't1', now: 1 })
  let calls = 0
  let release
  const github = { enabled: true, host: 'github.com', fetchIdentity: () => { calls++; return new Promise((resolve) => { release = () => resolve({ github_id: 1, login: 'dan', scopes: ['github.com/matronhq'] }) }) } }
  const logs = []
  const interval = scheduleGithubRefresh(db, github, { intervalMs: 15, log: (l) => logs.push(l) })
  t.after(() => clearInterval(interval))
  await new Promise((r) => setTimeout(r, 80))
  assert.equal(calls, 1, 'ticks while the first run is in flight do not start another walk')
  assert.ok(logs.some((l) => /still in progress, skipping/.test(l)))
  release()
  await new Promise((r) => setTimeout(r, 40))
  assert.ok(calls >= 2, 'once the run finishes, the next tick runs again')
})
