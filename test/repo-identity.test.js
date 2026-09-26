import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRepo, REPO_MAX } from '../src/repo-identity.js'

test('parseRepo: canonical strings split into host/org/name with a lower-cased scope', () => {
  assert.deepEqual(parseRepo('github.com/matronhq/matron-journal'), {
    repo: 'github.com/matronhq/matron-journal', scope: 'github.com/matronhq',
    host: 'github.com', org: 'matronhq', name: 'matron-journal',
  })
  // Name case is preserved; host and org must already be lower-case.
  assert.equal(parseRepo('github.com/matronhq/Matron-Journal').name, 'Matron-Journal')
})

test('parseRepo: rejects anything that is not host/org/name', () => {
  for (const bad of ['', 'github.com/matronhq', 'GitHub.com/matronhq/x', 'github.com/MatronHQ/x',
    'github.com/matronhq/x/y', 'git@github.com:matronhq/x.git', 'https://github.com/matronhq/x',
    'a'.repeat(REPO_MAX + 1), 42, null, undefined]) {
    assert.equal(parseRepo(bad), null, `should reject ${JSON.stringify(bad)}`)
  }
})
