// Secret-bearing paths the file viewer reads must never expose (2026-09-27
// hardening after the maintainer's review of the file viewer reads stack):
//   - ~/.secrets (operator-submitted secrets sit there for up to an hour),
//     the journal agent-token / bridge agent-creds, and the bridge state files;
//   - every top-level dot entry of the service user's home when a read-root
//     is $HOME, unless a root was configured inside that dot entry;
//   - the journal's own data directory (database, preapprove key, creds);
//   - a read-root of / is refused at boot.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { createUser } from '../src/auth.js'
import {
  isSensitivePath, pinAllowedRootsSync, withReadPolicy, isDeniedPath,
  openGuarded, FileLinkDenied,
} from '../src/file-guard.js'
import { makeTmpDir } from './tmp-dir.js'

const SECRET_PATHS = [
  '/root/.secrets', '/root/.secrets/req-abc.txt', '/home/u/.secret',
  '/root/.agent/approval_grant_secret', '/w/client.secret',
  '/root/.vendor-cli/access-token', '/etc/matron/agent-token', '/w/agent_token.json',
  '/srv/journal/data/bridge-agent-token.txt', '/srv/journal/data/bridge-agent-creds.txt',
  '/w/creds', '/w/deploy.creds.json',
  '/root/.claude-matrix-sessions.json', '/root/.claude-matrix-announced.json', '/root/.claude-matrix-bridge/x',
  '/root/.matron-bridge-secrets.json', '/root/.matron-bridge-timers.json', '/root/.matron-bridge-inflight.json',
  '/root/.claude-queued-release-outbox.json', '/root/.claude-run-state-outbox.json',
  '/root/.claude-subagent-running.json',
  '/srv/bridge/run-state-outbox.json', '/srv/bridge/journal-cursor.json',
  '/root/.bash_history', '/root/.python_history', '/root/.zsh_history',
  '/srv/bridge/.env.bak-2026-01-01',
]
const STILL_ALLOWED = [
  '/w/lib/secret-requests.js', '/w/secretary/notes.txt', '/w/tokenizer.js', '/w/docs/agent-token.md',
  '/w/src/credit.js', '/w/history.md', '/w/lib/journal-cursor.js', '/w/test/run-state-outbox.test.js',
]

test('isSensitivePath covers the secret-bearing paths the review found', () => {
  for (const p of SECRET_PATHS) assert.equal(isSensitivePath(p), true, `should deny ${p}`)
  for (const p of STILL_ALLOWED) assert.equal(isSensitivePath(p), false, `should allow ${p}`)
})

function makeHome() {
  const home = fs.realpathSync(makeTmpDir('matron-home-'))
  fs.writeFileSync(path.join(home, 'notes.md'), 'visible\n')
  fs.writeFileSync(path.join(home, '.bashrc'), 'export TOKEN=abc\n')
  fs.mkdirSync(path.join(home, '.acme.sh'))
  fs.writeFileSync(path.join(home, '.acme.sh', 'account.conf'), 'CF_Key=abc\n')
  fs.mkdirSync(path.join(home, '.devtool', 'workspace', 'src'), { recursive: true })
  fs.writeFileSync(path.join(home, '.devtool', 'workspace', 'src', 'a.js'), 'ok\n')
  fs.mkdirSync(path.join(home, '.devtool', 'backups'))
  fs.writeFileSync(path.join(home, '.devtool', 'backups', 'dump.sql'), 'secret rows\n')
  fs.mkdirSync(path.join(home, 'proj'))
  fs.writeFileSync(path.join(home, 'proj', '.eslintrc'), '{}\n') // a dotfile NOT at the top of $HOME
  return home
}

test('withReadPolicy refuses a read-root of /', () => {
  assert.throws(() => withReadPolicy(pinAllowedRootsSync(['/'])), /read-root of \/ is refused/)
})

test('home dot-entry rule: $HOME root denies top-level dot entries unless a root lives inside one', async () => {
  const home = makeHome()
  const ws = path.join(home, '.devtool', 'workspace')
  const homeOnly = withReadPolicy(pinAllowedRootsSync([home]), { homeDir: home })
  assert.equal(isDeniedPath(path.join(home, '.bashrc'), homeOnly), true)
  assert.equal(isDeniedPath(path.join(home, '.acme.sh', 'account.conf'), homeOnly), true)
  assert.equal(isDeniedPath(path.join(ws, 'src', 'a.js'), homeOnly), true)
  assert.equal(isDeniedPath(path.join(home, 'notes.md'), homeOnly), false)
  assert.equal(isDeniedPath(path.join(home, 'proj', '.eslintrc'), homeOnly), false)
  assert.equal(isDeniedPath(home, homeOnly), false)

  const withWs = withReadPolicy(pinAllowedRootsSync([home, ws]), { homeDir: home })
  assert.equal(isDeniedPath(path.join(ws, 'src', 'a.js'), withWs), false)
  assert.equal(isDeniedPath(path.join(home, '.devtool', 'backups', 'dump.sql'), withWs), true)
  assert.equal(isDeniedPath(path.join(home, '.devtool'), withWs), true)
  assert.equal(isDeniedPath(path.join(home, '.bashrc'), withWs), true)

  await assert.rejects(openGuarded(path.join(home, '.bashrc'), { allowedRoots: withWs }),
    (e) => e instanceof FileLinkDenied && e.reason === 'sensitive')
  const { fd } = await openGuarded(path.join(ws, 'src', 'a.js'), { allowedRoots: withWs })
  try { assert.equal(await fd.readFile('utf8'), 'ok\n') } finally { await fd.close() }

})


test('a denied tree yields only inside a root configured within it, never to a broader root', () => {
  const root = fs.realpathSync(makeTmpDir('matron-files-'))
  const data = path.join(root, 'data')
  fs.mkdirSync(path.join(data, 'uploads'), { recursive: true })
  const policy = withReadPolicy(pinAllowedRootsSync([root, path.join(data, 'uploads')]),
    { denyPaths: [path.join(data, 'matron.db')], denyTrees: [data], homeDir: null })
  assert.equal(isDeniedPath(path.join(data, 'bridge-notes.txt'), policy), true)
  assert.equal(isDeniedPath(path.join(data, 'uploads', 'a.png'), policy), false)
  // The named state stays denied even under a root configured AT the tree.
  const atTree = withReadPolicy(pinAllowedRootsSync([data]),
    { denyPaths: [path.join(data, 'matron.db')], denyTrees: [data], homeDir: null })
  assert.equal(isDeniedPath(path.join(data, 'matron.db'), atTree), true)
  assert.equal(isDeniedPath(path.join(data, 'notes.txt'), atTree), false)
})

async function clientToken(s) {
  await createUser(s.db, 'op', 'pw')
  const r = await s.http('/login', { method: 'POST', body: { username: 'op', password: 'pw', device_name: 'x' } })
  return r.json.token
}
const get = (s, q, token) => fetch(s.base + q, { headers: { authorization: `Bearer ${token}` } })

test('server: a read-root of / fails the boot', async () => {
  await assert.rejects(startTestServer({ fileReadRoots: ['/'] }), /read-root of \/ is refused/)
})

test('server: $HOME root hides ~/.secrets and dotfiles; an explicit workspace root stays readable', async (t) => {
  const home = makeHome()
  fs.mkdirSync(path.join(home, '.secrets'))
  fs.writeFileSync(path.join(home, '.secrets', 'req-1.txt'), 'hunter2\n')
  const ws = path.join(home, '.devtool', 'workspace')
  const s = await startTestServer({ fileReadRoots: [home, ws], fileHomeDir: home })
  t.after(() => s.close())
  const token = await clientToken(s)

  for (const p of [path.join(home, '.secrets', 'req-1.txt'), path.join(home, '.bashrc'), path.join(home, '.acme.sh', 'account.conf')]) {
    const r = await get(s, `/files/content?path=${encodeURIComponent(p)}`, token)
    assert.notEqual(r.status, 200, `${p} must not be served`)
    assert.ok(!(await r.text()).includes('hunter2'))
  }
  const ok = await get(s, `/files/content?path=${encodeURIComponent(path.join(ws, 'src', 'a.js'))}`, token)
  assert.equal(ok.status, 200)
})

test('server: the journal data directory is not readable through the file API', async (t) => {
  const root = fs.realpathSync(makeTmpDir('matron-files-'))
  fs.mkdirSync(path.join(root, 'data'))
  fs.writeFileSync(path.join(root, 'data', 'bridge-notes.txt'), 'inside data dir\n')
  fs.writeFileSync(path.join(root, 'readme.md'), 'hi\n')
  const s = await startTestServer({ dbPath: path.join(root, 'data', 'matron.db'), fileReadRoots: [root], fileHomeDir: null })
  t.after(() => s.close())
  const token = await clientToken(s)
  for (const name of ['matron.db', 'bridge-notes.txt']) {
    const r = await get(s, `/files/content?path=${encodeURIComponent(path.join(root, 'data', name))}`, token)
    assert.notEqual(r.status, 200, `${name} must not be served`)
  }
})
