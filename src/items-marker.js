// The 'item' marker event: what the conversation log carries about a
// tracker item (spec: Marker event). Written only by src/items-http.js;
// never publishable by an agent. Not a MESSAGE_TYPE (no unread/snippet
// column impact) — push.js and journal.js's snippetOf special-case it.
export const ITEM_EVENT_TYPE = 'item'
// 'updated' (a PATCH: retitle, relabel, or a hand-moved `awaiting`) and
// 'reordered' are the two quiet ones: both are journal-sync material, so
// neither wakes a sleeping box (WAKE_ACTIONS in items-http.js) nor pushes
// (classify() in push.js). They still get a marker so a connected client
// learns of the change without re-polling /items.
export const ITEM_ACTIONS = ['created', 'commented', 'closed', 'reopened', 'reordered', 'updated']

export function itemMarkerPayload({ item, action, by, comment = null }) {
  const payload = {
    item_id: item.id,
    num: item.num,
    kind: item.kind,
    title: item.title,
    action,
    by,
    awaiting: item.awaiting ?? null,
    resolution: item.resolution ?? null,
  }
  if (comment && (comment.body || (comment.attachments && comment.attachments.length))) {
    payload.comment = {
      id: comment.id,
      body: comment.body,
      attachments: (comment.attachments || []).map((a) => ({
        blob_ref: a.blob_ref, mime: a.mime, name: a.name, size: a.size, transcript: a.transcript ?? null,
      })),
    }
  }
  return payload
}

// Old-client fallback (spec: "Old-client fallback"). A pre-tracker client
// cannot render an `item` marker at all, so the journal also writes a plain
// `text` event flagged `fallback_for:'item'` that every existing client
// already renders; new clients hide it (JournalTimelineMapper,
// journal-input-router). Only these four actions produce card-worthy
// traffic — 'reordered' and 'updated' are bookkeeping a connected client
// picks up from the marker alone, so itemFallbackText returns null for them
// and emitMarker (items-http.js) never calls appendAndBroadcast for a text.
export const FALLBACK_ACTIONS = new Set(['created', 'commented', 'closed', 'reopened'])

const oneLine = (v) => String(v ?? '').replace(/\s+/g, ' ').trim()
const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s)
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1)

// Pure: no DB, no clock. `p` is an itemMarkerPayload() result (or shares its
// shape); `actor` is the display name (senderOf()'s `agent:dev-2` /
// `user:dan` with the prefix stripped by the caller); `body` is the item's
// body text, but ONLY for `created` — the marker payload itself never
// carries the item body, and every other action's prose lives on `p.comment`.
export function itemFallbackText(p, { actor = 'someone', body = null } = {}) {
  if (!FALLBACK_ACTIONS.has(p.action)) return null
  const kind = oneLine(p.kind || 'item')
  const title = cut(oneLine(p.title), 120)
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
