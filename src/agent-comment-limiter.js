// Throttle for agent comments that wake another conversation's agent
// (items-http.js). Per (item, commenter conversation): one delivered comment
// per PER_PAIR_MS; per item: at most PER_ITEM_MAX across all commenters in
// PER_ITEM_MS. Only delivered comments count. In memory, bounded: expired
// entries are pruned on access and the map is capped.
const PER_PAIR_MS = 30_000
const PER_ITEM_MS = 10 * 60_000
const PER_ITEM_MAX = 6
const MAP_MAX = 5000

export function makeAgentCommentLimiter({ now = Date.now } = {}) {
  const pairs = new Map() // `${itemId}|${convoId}` -> last delivered ms
  const items = new Map() // itemId -> delivered timestamps within PER_ITEM_MS
  const prune = (t) => {
    for (const [k, ts] of pairs) if (t - ts >= PER_PAIR_MS) pairs.delete(k)
    for (const [k, arr] of items) {
      const live = arr.filter((x) => t - x < PER_ITEM_MS)
      if (live.length) items.set(k, live); else items.delete(k)
    }
  }
  return {
    // true = delivered (and counted); false = throttled.
    take(itemId, fromConvoId) {
      const t = now()
      const key = `${itemId}|${fromConvoId}`
      // Entries this call would add. Over the cap even after dropping the
      // expired ones, a new entry is throttled rather than letting the maps
      // grow: live limits are never evicted, so they are never weakened.
      const needed = (pairs.has(key) ? 0 : 1) + (items.has(itemId) ? 0 : 1)
      if (pairs.size + items.size + needed > MAP_MAX) {
        prune(t)
        if (pairs.size + items.size + needed > MAP_MAX) return false
      }
      const last = pairs.get(key)
      if (last != null && t - last < PER_PAIR_MS) return false
      const recent = (items.get(itemId) ?? []).filter((x) => t - x < PER_ITEM_MS)
      if (recent.length >= PER_ITEM_MAX) { items.set(itemId, recent); return false }
      recent.push(t)
      items.set(itemId, recent)
      pairs.set(key, t)
      return true
    },
    // Give back the slot a take() reserved, when the delivery then failed.
    release(itemId, fromConvoId) {
      pairs.delete(`${itemId}|${fromConvoId}`)
      const arr = items.get(itemId)
      if (!arr) return
      arr.pop()
      if (!arr.length) items.delete(itemId)
    },
  }
}
