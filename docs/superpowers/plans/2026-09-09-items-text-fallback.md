# Items text fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every item marker that new clients render as a card or note is mirrored as a plain `text` event that pre-tracker clients already render, and new clients hide.

**Architecture:** The journal writes the fallback right after the marker (same conversation, same sender) with a `fallback_for: "item"` payload flag. The bridge and the Apple apps drop flagged texts; push and search ignore them; unread/snippet treat them as ordinary text.

**Tech Stack:** Node (journal, bridge: `node --test` / vitest), Swift 6 (MatronShared, XCTest).

**Spec:** `docs/superpowers/specs/2026-09-08-task-decision-tracker-design.md`, section "Old-client fallback".

## Global Constraints
- Flag name is exactly `fallback_for` with value `"item"`; extra fields `item_id`, `num`, `action`.
- Never log item titles/bodies at `.public`.
- Journal: never print tokens. Apps: never stage `Matron/App/Info.plist`; SPM tests with `MATRON_SKIP_SNAPSHOT_TESTS=1`.
- Each task commits to its repo's existing PR branch (journal `items-tracker`, bridge `items-tracker`, apple `items-tracker-core`) and pushes.

---

### Task 1: Journal emits the fallback; push and search ignore it

**Files:**
- Modify: `src/items-marker.js` (add `itemFallbackText`, `FALLBACK_ACTIONS`)
- Modify: `src/items-http.js` (`emitMarker`: append the fallback after the marker; `created` needs `item.body`)
- Modify: `src/push.js` (`classify`: null for flagged text), `src/search.js` (`indexableBody`: null for flagged text)
- Modify: `docs/protocol.md` (marker section: document the fallback event), `src/help.js` (one line: agents must not publish their own fallback texts)
- Test: `test/items.test.js` (pure text function), `test/items-http.test.js`, `test/push.test.js`, `test/search.test.js`

**Interfaces:**
- Produces: `itemFallbackText(payload, { actor, body }) -> string`; wire event `{type:'text', payload:{body, fallback_for:'item', item_id, num, action}}`.

- [ ] **Step 1: Failing tests for the text function** (`test/items.test.js`):
```js
import { itemFallbackText } from '../src/items-marker.js'
test('itemFallbackText: the six shapes', () => {
  const base = { item_id: 'it_1', num: 12, kind: 'question', title: 'Which auth library?', by: 'agent', awaiting: 'user', resolution: null }
  assert.equal(itemFallbackText({ ...base, action: 'created' }, { actor: 'dev-2', body: 'we have two' }), '📌 Needs you — question #12: Which auth library?\nwe have two')
  assert.equal(itemFallbackText({ ...base, action: 'created', by: 'user', awaiting: 'agent' }, { actor: 'dan' }), '📌 New question #12: Which auth library?')
  assert.equal(itemFallbackText({ ...base, action: 'commented', comment: { id: 'ic', body: 'A or B?', attachments: [] } }, { actor: 'dev-2' }), '📌 Needs you — question #12 "Which auth library?" — dev-2 asked:\nA or B?')
  assert.equal(itemFallbackText({ ...base, action: 'commented', by: 'user', awaiting: 'agent', comment: { id: 'ic', body: 'B', attachments: [{ name: 'note.m4a', mime: 'audio/mp4' }] } }, { actor: 'dan' }), '📌 Question #12 "Which auth library?" — dan commented:\nB\n[voice note note.m4a]')
  assert.equal(itemFallbackText({ ...base, action: 'closed', resolution: 'answered', awaiting: null }, { actor: 'dan' }), '✅ Question #12 "Which auth library?" closed as answered')
  assert.equal(itemFallbackText({ ...base, action: 'reopened', by: 'user', awaiting: 'agent' }, { actor: 'dan' }), '↩️ Question #12 "Which auth library?" reopened by dan')
  assert.equal(itemFallbackText({ ...base, action: 'reordered' }, { actor: 'dan' }), null)
  const long = 'x'.repeat(130)
  assert.ok(itemFallbackText({ ...base, action: 'created', title: long, by: 'user', awaiting: 'agent' }, { actor: 'dan' }).startsWith('📌 New question #12: ' + 'x'.repeat(120) + '…'))
})
```
- [ ] **Step 2: Run** `node --test test/items.test.js` → FAIL (not exported).
- [ ] **Step 3: Implement** in `src/items-marker.js`:
```js
export const FALLBACK_ACTIONS = new Set(['created', 'commented', 'closed', 'reopened'])
const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)
export function itemFallbackText(p, { actor = 'someone', body = null } = {}) {
  if (!FALLBACK_ACTIONS.has(p.action)) return null
  const kind = oneLine(p.kind || 'item'); const title = cut(oneLine(p.title), 120)
  const head = `${cap(kind)} #${p.num} "${title}"`
  const needsUser = p.by === 'agent' && p.awaiting === 'user'
  const lines = []
  const c = p.comment && typeof p.comment === 'object' ? p.comment : null
  const text = c ? c.body : (p.action === 'created' ? body : null)
  if (typeof text === 'string' && text.trim()) lines.push(cut(text.trim(), 500))
  for (const a of Array.isArray(c?.attachments) ? c.attachments : []) {
    const name = oneLine(a?.name) || 'attachment'
    lines.push(String(a?.mime || '').startsWith('audio/') ? `[voice note ${name}]` : `[attachment ${name}]`)
  }
  let first
  if (p.action === 'created') first = needsUser ? `📌 Needs you — ${kind} #${p.num}: ${title}` : `📌 New ${kind} #${p.num}: ${title}`
  else if (p.action === 'commented') first = needsUser ? `📌 Needs you — ${kind} #${p.num} "${title}" — ${actor} asked:` : `📌 ${head} — ${actor} commented:`
  else if (p.action === 'closed') first = `✅ ${head} closed as ${p.resolution ?? 'closed'}`
  else first = `↩️ ${head} reopened by ${actor}`
  return [first, ...lines].join('\n')
}
```
- [ ] **Step 4: Failing HTTP test** (`test/items-http.test.js`): after an agent `POST /items` with `awaiting:'user'` and a body, the conversation's events end with an `item` marker followed by a `text` whose payload has `fallback_for:'item'`, `item_id`, `num`, `action:'created'`, same `sender` as the marker, body starting `📌 Needs you — `; a `/rank` produces no text; `/close` produces a `✅` text; a user comment produces a `user:`-sender text.
- [ ] **Step 5: Implement in `emitMarker`** (`src/items-http.js`): after the marker's `appendAndBroadcast` succeeds and the push call, if `FALLBACK_ACTIONS.has(action)`: `const text = itemFallbackText(payload, { actor: sender.slice(sender.indexOf(':') + 1), body: action === 'created' ? item.body : null })`, then `appendAndBroadcast(db, hub, { userId, convoId: item.origin_convo_id, sender, type: 'text', payload: { body: text, fallback_for: 'item', item_id: item.id, num: item.num, action } })` inside its own try/catch that logs `items: fallback append failed` and continues; then `pushPipeline.onAppend(...)` for it too (classify will return null — keep the pipeline honest). The wake call stays keyed off the marker only.
- [ ] **Step 6: push + search**: `test/push.test.js` add `classify('text', { body: '📌 x', fallback_for: 'item' }, 'agent:dev-2', …)` → `null`; `test/search.test.js` add `indexableBody('text', { body: 'x', fallback_for: 'item' })` → `null`. Implement: in `classify`, right after the `user:` rule: `if (type === 'text' && payload && typeof payload === 'object' && payload.fallback_for) return null`; in `indexableBody`: `if (p.fallback_for) return null` at the top.
- [ ] **Step 7:** docs (`docs/protocol.md` marker section + `src/help.js`), `npm test` all green, commit `items: journal mirrors card-worthy markers as flagged text for pre-tracker clients`, push.

### Task 2: Bridge ignores flagged fallback texts

**Files:**
- Modify: `lib/journal-input-router.js` (in `onJournalEvent`, before the `type === 'text'` routing: drop flagged frames)
- Test: `test/journal-input-router.test.js`

- [ ] **Step 1: Failing test**: a frame `{ sender: 'user:dan', type: 'text', payload: { body: '📌 Task #1 "x" — dan commented:\nhi', fallback_for: 'item' } }` for a live session results in NO `routeTextToSession` call and no warn; an identical frame without the flag routes as before.
- [ ] **Step 2: Implement**: at the top of the text branch: `if (payload && typeof payload === 'object' && payload.fallback_for) return; // journal's old-client mirror of an item marker — the marker path already delivered the turn`. Also guard the sessionless/queued paths if a text can reach them (grep `type === 'text'`); one shared `isFallbackText(frame)` helper.
- [ ] **Step 3:** `npx vitest run test/journal-input-router.test.js`, then the full suite; commit `items: bridge ignores the journal's flagged fallback texts`; push.

### Task 3: Apps hide flagged fallback texts

**Files:**
- Modify: `MatronShared/Sources/Chat/JournalTimelineMapper.swift` (text case: return nil when `payload["fallback_for"] != nil`)
- Modify: `MatronShared/Sources/Journal/JournalStore.swift` (outbox delivery confirmation: skip frames with `fallback_for`)
- Test: `MatronShared/Tests/ChatTests/JournalTimelineMapperItemTests.swift`

- [ ] **Step 1: Failing test**: a `text` event with payload `{"body":"📌 New task #3: x","fallback_for":"item","item_id":"it_3","num":3,"action":"created"}` maps to `nil`; the same payload without the flag maps to `.text`.
- [ ] **Step 2: Implement** the guard in the mapper's `text` case with a comment pointing at the spec section; add the outbox-confirm guard.
- [ ] **Step 3:** `MATRON_SKIP_SNAPSHOT_TESTS=1 swift test --package-path MatronShared --filter "JournalTimelineMapper|JournalStore"`; commit `items: apps hide the journal's flagged fallback texts`; push to `items-tracker-core`.
