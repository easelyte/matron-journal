// bin/run-named-node and bin/matron-journal: on macOS the journal runs from a
// copy of node named "matron-journal"; elsewhere, or when opted out, under
// node itself. The real node is swapped for a tiny sh script that answers
// node's execPath query and otherwise prints how it was invoked, so these
// tests see which file was exec'd and with what arguments.
// MATRON_NAMED_NODE_FORCE=1 takes the macOS path on any OS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const LAUNCHER = path.join(ROOT, 'bin', 'run-named-node')
const JOURNAL = path.join(ROOT, 'bin', 'matron-journal')
const posix = { skip: process.platform === 'win32' && 'POSIX sh launcher' }

// Answers `-e <code>` (the launcher's execPath query) with its own path, as
// node does; any other invocation prints $0, each argument and the
// MATRON_REAL_NODE the launcher exported.
const FAKE_NODE = `#!/bin/sh
if [ "$1" = -e ]; then printf %s "$0"; exit 0; fi
printf 'argv0=%s\\n' "$0"
for a in "$@"; do printf 'arg=%s\\n' "$a"; done
printf 'real=%s\\n' "\${MATRON_REAL_NODE:-}"
`

function writeExecutable (file, body) {
  fs.writeFileSync(file, body)
  fs.chmodSync(file, 0o755)
}

// A fresh sandbox per test: fake node, target dir, and a runner.
function sandbox (t) {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'run-named-node-')))
  const fakeNode = path.join(tmp, 'node')
  writeExecutable(fakeNode, FAKE_NODE)
  const binDir = path.join(tmp, 'named-bin')
  t.after(() => {
    try { fs.chmodSync(binDir, 0o755) } catch { /* not created */ }
    fs.rmSync(tmp, { recursive: true, force: true })
  })
  const run = (args, env = {}, script = LAUNCHER) => {
    const res = spawnSync('/bin/sh', [script, ...args], {
      encoding: 'utf8',
      env: {
        PATH: '/usr/bin:/bin',
        HOME: tmp,
        NODE_BIN: fakeNode,
        MATRON_NAMED_NODE_DIR: binDir,
        MATRON_NAMED_NODE_FORCE: '1',
        ...env
      }
    })
    return { status: res.status, stdout: res.stdout, stderr: res.stderr }
  }
  return { tmp, fakeNode, binDir, copy: path.join(binDir, 'matron-test'), run }
}

function parse (stdout) {
  const lines = stdout.trimEnd().split('\n')
  return {
    argv0: lines.find((l) => l.startsWith('argv0='))?.slice(6),
    args: lines.filter((l) => l.startsWith('arg=')).map((l) => l.slice(4)),
    real: lines.find((l) => l.startsWith('real='))?.slice(5)
  }
}

const seconds = (ms) => Math.floor(ms / 1000)

test('run-named-node: both launchers are executable POSIX sh scripts', posix, () => {
  for (const file of [LAUNCHER, JOURNAL]) {
    const fd = fs.openSync(file, 'r')
    try {
      assert.notEqual(fs.fstatSync(fd).mode & 0o111, 0)
      assert.equal(fs.readFileSync(fd, 'utf8').split('\n')[0], '#!/bin/sh')
    } finally {
      fs.closeSync(fd)
    }
  }
})

test('run-named-node: copies node under the given name and execs the script with it', posix, (t) => {
  const s = sandbox(t)
  const res = s.run(['matron-test', '/srv/app/server.js', 'one', 'two words'])
  assert.equal(res.status, 0)
  assert.equal(res.stderr, '')
  assert.deepEqual(parse(res.stdout), {
    argv0: s.copy,
    args: ['/srv/app/server.js', 'one', 'two words'],
    real: s.fakeNode
  })
  assert.equal(fs.readFileSync(s.copy, 'utf8'), FAKE_NODE)
  assert.equal(fs.statSync(s.copy).mode & 0o777, 0o755)
  assert.equal(seconds(fs.statSync(s.copy).mtimeMs), seconds(fs.statSync(s.fakeNode).mtimeMs))
  assert.deepEqual(fs.readdirSync(s.binDir), ['matron-test'], 'no temp file left behind')
})

test('run-named-node: reuses a fresh copy instead of copying again', posix, (t) => {
  const s = sandbox(t)
  s.run(['matron-test', 'a.js'])
  const ino = fs.statSync(s.copy).ino
  assert.equal(parse(s.run(['matron-test', 'b.js']).stdout).argv0, s.copy)
  assert.equal(fs.statSync(s.copy).ino, ino)
})

test('run-named-node: refreshes the copy when node changes size', posix, (t) => {
  const s = sandbox(t)
  s.run(['matron-test', 'a.js'])
  const upgraded = `${FAKE_NODE}# upgraded\n`
  // Rewrite node but keep its mtime (which the copy shares, via cp -p), so
  // only the size gives the change away.
  const fd = fs.openSync(s.fakeNode, 'r+')
  try {
    const { atime, mtime } = fs.fstatSync(fd)
    fs.ftruncateSync(fd, 0)
    fs.writeSync(fd, upgraded, 0)
    fs.futimesSync(fd, atime, mtime)
  } finally {
    fs.closeSync(fd)
  }
  assert.equal(parse(s.run(['matron-test', 'b.js']).stdout).argv0, s.copy)
  assert.equal(fs.readFileSync(s.copy, 'utf8'), upgraded)
})

test('run-named-node: refreshes the copy when node changes mtime', posix, (t) => {
  const s = sandbox(t)
  s.run(['matron-test', 'a.js'])
  const ino = fs.statSync(s.copy).ino
  const later = new Date(fs.statSync(s.fakeNode).mtimeMs + 60_000)
  fs.utimesSync(s.fakeNode, later, later)
  s.run(['matron-test', 'b.js'])
  assert.notEqual(fs.statSync(s.copy).ino, ino)
  assert.equal(seconds(fs.statSync(s.copy).mtimeMs), seconds(later.getTime()))
})

test('run-named-node: copies the binary node reports, not a version-manager shim in front of it', posix, (t) => {
  const s = sandbox(t)
  const shim = path.join(s.tmp, 'shim-node')
  writeExecutable(shim, `#!/bin/sh
if [ "$1" = -e ]; then printf %s '${s.fakeNode}'; exit 0; fi
exec '${s.fakeNode}' "$@"
`)
  const out = parse(s.run(['matron-test', 'a.js'], { NODE_BIN: shim }).stdout)
  assert.equal(out.argv0, s.copy)
  assert.equal(out.real, s.fakeNode)
  assert.equal(fs.readFileSync(s.copy, 'utf8'), FAKE_NODE)
})

test('run-named-node: finds node on PATH when NODE_BIN is unset', posix, (t) => {
  const s = sandbox(t)
  const out = parse(s.run(['matron-test', 'a.js'], { NODE_BIN: '', PATH: `${s.tmp}:/usr/bin:/bin` }).stdout)
  assert.equal(out.argv0, s.copy)
  assert.equal(out.real, s.fakeNode)
})

test('run-named-node: defaults the copy directory to $HOME/.matron/bin', posix, (t) => {
  const s = sandbox(t)
  const out = parse(s.run(['matron-test', 'a.js'], { MATRON_NAMED_NODE_DIR: '' }).stdout)
  assert.equal(out.argv0, path.join(s.tmp, '.matron', 'bin', 'matron-test'))
})

test('run-named-node: runs node itself, with no copy, when MATRON_NAMED_NODE=0', posix, (t) => {
  const s = sandbox(t)
  const res = s.run(['matron-test', 'a.js', 'x'], { MATRON_NAMED_NODE: '0' })
  assert.equal(res.status, 0)
  assert.deepEqual(parse(res.stdout), { argv0: s.fakeNode, args: ['a.js', 'x'], real: '' })
  assert.equal(fs.existsSync(s.binDir), false)
})

test('run-named-node: runs node itself on systems other than macOS', {
  skip: (process.platform === 'darwin' || process.platform === 'win32') && 'needs a non-macOS POSIX host'
}, (t) => {
  const s = sandbox(t)
  const out = parse(s.run(['matron-test', 'a.js'], { MATRON_NAMED_NODE_FORCE: '' }).stdout)
  assert.deepEqual(out, { argv0: s.fakeNode, args: ['a.js'], real: '' })
  assert.equal(fs.existsSync(s.binDir), false)
})

test('run-named-node: refuses names outside ^matron-[a-z0-9-]+$', posix, (t) => {
  const s = sandbox(t)
  for (const name of ['journal', 'matron-', 'matron-Journal', 'matron-a/b', 'matron-a b', 'matron-a.b', '../matron-x', 'xmatron-a']) {
    const res = s.run([name, 'a.js'])
    assert.equal(res.status, 64, name)
    assert.equal(res.stdout, '', name)
    assert.match(res.stderr, /refusing name/, name)
  }
  assert.equal(fs.existsSync(s.binDir), false)
})

test('run-named-node: refuses to run without a script', posix, (t) => {
  const s = sandbox(t)
  const res = s.run(['matron-test'])
  assert.equal(res.status, 64)
  assert.match(res.stderr, /usage/)
})

test('run-named-node: falls back to node itself, with one warning, when the copy cannot be written', {
  skip: (process.platform === 'win32' && 'POSIX sh launcher') || (process.getuid?.() === 0 && 'root can write anywhere')
}, (t) => {
  const s = sandbox(t)
  fs.mkdirSync(s.binDir)
  fs.chmodSync(s.binDir, 0o555)
  const res = s.run(['matron-test', 'a.js', 'x'])
  assert.equal(res.status, 0)
  assert.deepEqual(parse(res.stdout), { argv0: s.fakeNode, args: ['a.js', 'x'], real: '' })
  assert.equal(res.stderr.trimEnd().split('\n').length, 1)
  assert.match(res.stderr, /^run-named-node: could not copy /)
})

test('run-named-node: falls back to node itself when node cannot report its own binary', posix, (t) => {
  const s = sandbox(t)
  const odd = path.join(s.tmp, 'odd-node')
  writeExecutable(odd, `#!/bin/sh
if [ "$1" = -e ]; then printf %s 'relative/node'; exit 0; fi
printf 'argv0=%s\\n' "$0"
`)
  const res = s.run(['matron-test', 'a.js'], { NODE_BIN: odd })
  assert.equal(res.status, 0)
  assert.equal(parse(res.stdout).argv0, odd)
  assert.match(res.stderr, /^run-named-node: could not locate the node binary/)
  assert.equal(fs.existsSync(s.binDir), false)
})

test('matron-journal: runs src/server.js as matron-journal, passing arguments through', posix, (t) => {
  const s = sandbox(t)
  const res = s.run(['--flag', 'value'], {}, JOURNAL)
  assert.equal(res.status, 0)
  assert.deepEqual(parse(res.stdout), {
    argv0: path.join(s.binDir, 'matron-journal'),
    args: [path.join(fs.realpathSync(ROOT), 'src', 'server.js'), '--flag', 'value'],
    real: s.fakeNode
  })
})

test('matron-journal: works when started through a symlink', posix, (t) => {
  const s = sandbox(t)
  const link = path.join(s.tmp, 'journal-link')
  fs.symlinkSync(JOURNAL, link)
  const out = parse(s.run([], {}, link).stdout)
  assert.equal(out.args[0], path.join(fs.realpathSync(ROOT), 'src', 'server.js'))
})

test('matron-journal: npm start uses the launcher', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.equal(pkg.scripts.start, 'bin/matron-journal')
})
