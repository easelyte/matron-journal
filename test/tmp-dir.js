// Per-test scratch directories that clean themselves up.
//
// makeTmpDir(prefix) is fs.mkdtempSync under os.tmpdir(), but every directory
// it creates is removed again, so a test file leaves nothing in the machine's
// /tmp:
//
//   - before each top-level test, the directories created by earlier tests are
//     removed. Those tests have fully finished by then, t.after() teardown
//     (server close, db close) included, so nothing still writes into them.
//     This is what bounds the leak when the runner kills a file mid-run on
//     --test-timeout: only the in-flight test's directories survive.
//   - a root after() hook plus a process 'exit' fallback remove the rest.
//
// Use it for per-test scratch only: call it from a test body (or a fixture
// function a test body calls), not at module scope, from before(), or across
// subtests, since a later test's cleanup would remove a directory still in use.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, beforeEach } from 'node:test'

const dirs = new Set()

function removeAll() {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true })
  dirs.clear()
}

beforeEach((t) => {
  // Subtests inherit root hooks; only a new top-level test means the previous
  // one is done with its directories.
  if (!t.fullName.includes(' > ')) removeAll()
})
after(removeAll)
process.once('exit', removeAll)

export function makeTmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  dirs.add(dir)
  return dir
}
