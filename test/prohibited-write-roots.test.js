// The service user's home is a prohibited file write-root, the same way /root is.
// When the runtime runs as root, the prohibited set must be unchanged.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { pinAllowedRootsSync } from '../src/file-guard.js'
import {
  assertNoProhibitedFileWriteRoots,
  pinProhibitedFileWriteRootsSync,
  prohibitedFileWriteRoots,
} from '../src/server.js'
import { makeTmpDir } from './tmp-dir.js'

const LEGACY_ROOTS = ['/', '/root', '/opt/matron']
const SERVER_JS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js')

test('as root the prohibited write-roots equal the legacy set', () => {
  assert.deepEqual(prohibitedFileWriteRoots('/root'), new Set(LEGACY_ROOTS))
})

test('a non-root service user adds its home to the prohibited write-roots', () => {
  assert.deepEqual(prohibitedFileWriteRoots('/home/user'), new Set([...LEGACY_ROOTS, '/home/user']))
})

test('an empty or relative home adds nothing', () => {
  assert.deepEqual(prohibitedFileWriteRoots(''), new Set(LEGACY_ROOTS))
  assert.deepEqual(prohibitedFileWriteRoots('relative/home'), new Set(LEGACY_ROOTS))
})

test("the default prohibited set follows the service user's passwd home", () => {
  assert.deepEqual(prohibitedFileWriteRoots(), prohibitedFileWriteRoots(os.userInfo().homedir))
})

test('an overridden HOME does not change the default set', () => {
  const home = makeTmpDir('matron-fake-home-')
  const out = execFileSync(process.execPath, [
    '--input-type=module', '-e',
    `const m = await import(${JSON.stringify(SERVER_JS)});
     process.stdout.write(JSON.stringify([...m.prohibitedFileWriteRoots()]))`,
  ], { env: { ...process.env, HOME: home }, encoding: 'utf8' })
  assert.deepEqual(new Set(JSON.parse(out)), prohibitedFileWriteRoots(os.userInfo().homedir))
  assert.ok(!JSON.parse(out).includes(home), `default set ${out} picked up HOME ${home}`)
  if (process.getuid?.() === 0) assert.deepEqual(new Set(JSON.parse(out)), new Set(LEGACY_ROOTS))
})

test("the service user's home is refused as a write-root, directories below it are not", () => {
  const home = makeTmpDir('matron-fake-home-')
  const prohibited = pinProhibitedFileWriteRootsSync(prohibitedFileWriteRoots(home))
  assert.ok(prohibited.roots.some((r) => r.realPath === home))
  assert.throws(
    () => assertNoProhibitedFileWriteRoots(pinAllowedRootsSync([home]), prohibited),
    (err) => err?.message === `file writes: configured write-root is prohibited because it is too broad: ${home}`,
  )
  const below = path.join(home, 'workspace')
  mkdirSync(below)
  assert.doesNotThrow(() => assertNoProhibitedFileWriteRoots(pinAllowedRootsSync([below]), prohibited))
})
