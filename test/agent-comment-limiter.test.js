import test from 'node:test'
import assert from 'node:assert/strict'
import { makeAgentCommentLimiter } from '../src/agent-comment-limiter.js'

test('map cap holds: once full of live entries, new pairs are throttled, existing limits intact', () => {
  let t = 1_000_000
  const lim = makeAgentCommentLimiter({ now: () => t })
  // 2500 distinct items => 2500 pair + 2500 item entries = the 5000 cap.
  for (let i = 0; i < 2500; i++) assert.equal(lim.take(`i${i}`, 'c'), true)
  // A new item cannot grow the maps, even though nothing has expired.
  assert.equal(lim.take('fresh', 'c'), false)
  // An existing item's live limit is untouched (still throttled by its own pair window).
  assert.equal(lim.take('i0', 'c'), false)
  // Once entries expire, capacity returns.
  t += 11 * 60_000
  assert.equal(lim.take('fresh', 'c'), true)
})

test('release frees the reserved slot', () => {
  const lim = makeAgentCommentLimiter({ now: () => 5_000_000 })
  assert.equal(lim.take('i', 'c'), true)
  assert.equal(lim.take('i', 'c'), false)
  lim.release('i', 'c')
  assert.equal(lim.take('i', 'c'), true)
})
