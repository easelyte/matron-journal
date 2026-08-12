// One-time cleanup of bridge-baked title prefixes.
//
// Bridges used to prefix every journal conversation title with their
// SERVER_LABEL, in two shapes:
//   `DEV-:a3 Fix the thing`  — first-user-message fallback and Gemini title
//                              pass (2-char session-id fragment after the
//                              colon)
//   `DEV-: matron-apple`     — the workdir-basename seed
// The label is now data (conversations.agent_device_id, rendered as a chip
// by the apps) rather than text, and bridges no longer bake it in. This
// heals what is already stored.
//
// SHAPE ALONE IS NOT EVIDENCE. `Q: help`, `2: fix` and `Note: document` all
// have the seed shape and none of them is a baked prefix. This migration
// rewrites a live database exactly once (the user_version gate below), so a
// false positive is unrecoverable data loss, while a false negative leaves a
// cosmetic `DEV-: ` in a title that the next Gemini title pass refreshes
// anyway. So every strip has to name a label this database can VOUCH for:
// the prefix token must equal a SERVER_LABEL derivable from one of the
// user's own agent-box device names. Unknown token -> no rewrite.
const LABEL_MAX_CHARS = 12
// `LABEL` + `:` + exactly two alphanumerics (a UUID or Matrix-localpart
// fragment) + space — the fallback/Gemini form.
const FALLBACK = /^([^\s:]{1,12}):[0-9a-zA-Z]{2}\s+/
// `LABEL` + `: ` + a single space-free token to the end — the workdir seed.
const SEED = /^([^\s:]{1,12}):\s+(\S+)$/

// The SERVER_LABEL a box with this device name would have produced,
// reproducing the bridge's derivation verbatim (matron-bridge index.js, the
// `const SERVER_LABEL = process.env.SERVER_LABEL || (() => {...})()` IIFE):
//
//   const match = hostname.match(/^(\w+)-(\d+)/)
//   if (match) return match[2]                  // just the number
//   return hostname.slice(0, 4).toUpperCase()
//
// The numbered branch is `\w+-\d+` — ANY word, not `dev-` specifically,
// whatever the line comment above it in the bridge says. A box named
// `build-7` genuinely labels itself `7`, so `7` has to be a candidate for
// that box or its titles never heal. Narrowing this to `dev-` would not be
// the conservative choice; it would just be wrong about a real bridge.
//
// Where the two sides genuinely cannot be made to agree, this errs toward
// producing NO usable candidate, which means no strip:
//   - the bridge slices the HOSTNAME, and a journal device name is chosen at
//     pairing and only conventionally equals it. Both the four-char slice and
//     the whole name are offered; if the operator named the device something
//     unrelated to the hostname, neither matches and nothing is stripped.
//   - an explicit `SERVER_LABEL=` in the box's environment is unknowable from
//     here. The whole-name candidate covers the common case of setting it to
//     the box's own name; any other value simply never heals.
// Comparison is case-insensitive: the bridge upper-cases its slice, pairing
// does not.
//
// Candidates that could never appear as a `LABEL:` prefix — empty, longer
// than the label cap, or containing whitespace or a colon (client names like
// `Dan Mac`) — are dropped rather than matched loosely.
export function labelCandidates(name) {
  if (typeof name !== 'string') return []
  const trimmed = name.trim()
  if (!trimmed) return []
  const numbered = /^\w+-(\d+)/.exec(trimmed)
  const out = numbered ? [numbered[1]] : []
  out.push(trimmed.slice(0, 4), trimmed)
  return [...new Set(out
    .filter((l) => l && l.length <= LABEL_MAX_CHARS && !/[\s:]/.test(l))
    .map((l) => l.toLowerCase()))]
}

// Union of the candidates for a list of device names, ready for
// stripServerLabel.
export function labelSet(names) {
  const set = new Set()
  for (const n of names) for (const c of labelCandidates(n)) set.add(c)
  return set
}

// `labels` is a Set of lower-cased known SERVER_LABELs (see labelSet). No
// labels means no rewrite — that is the safe direction.
export function stripServerLabel(title, labels) {
  if (typeof title !== 'string' || !title) return ''
  if (!labels || labels.size === 0) return title
  const known = (m) => labels.has(m[1].toLowerCase())
  const fallback = title.match(FALLBACK)
  if (fallback && known(fallback)) return title.slice(fallback[0].length)
  const seed = title.match(SEED)
  if (seed && known(seed)) return seed[2]
  return title
}

// Runs once per database, gated on PRAGMA user_version (unused elsewhere in
// this repo, so version 1 is ours). The gate is a belt to the label check's
// braces: healed titles no longer match, so a re-run is a no-op anyway.
// `force` is for tests only.
//
// Every rewrite is logged: BYOS users run this unattended on their own
// server and deserve an audit trail of what their titles used to be.
export function healBakedTitles(db, { log = () => {}, force = false } = {}) {
  if (!force && db.pragma('user_version', { simple: true }) >= 1) return { scanned: 0, healed: 0 }
  // Only agent boxes ever baked a label. Two views of the same names: the
  // box's own labels, used when a conversation records which box manages it,
  // and the owner's union for the rows that predate that column.
  const agents = db.prepare("SELECT id, user_id, name FROM devices WHERE kind='agent'").all()
  const byDevice = new Map()
  const byUser = new Map()
  for (const a of agents) {
    const labels = new Set(labelCandidates(a.name))
    byDevice.set(a.id, { userId: a.user_id, labels })
    let union = byUser.get(a.user_id)
    if (!union) byUser.set(a.user_id, (union = new Set()))
    for (const c of labels) union.add(c)
  }
  const rows = db.prepare('SELECT id, owner_user_id, title, agent_device_id FROM conversations').all()
  const update = db.prepare('UPDATE conversations SET title=? WHERE id=?')
  let healed = 0
  const run = db.transaction(() => {
    for (const row of rows) {
      // `title` is NOT NULL in the schema, but a stray non-string would be
      // rewritten to '' by stripServerLabel's guard — a heal must never
      // erase a title it does not recognise.
      if (typeof row.title !== 'string') continue
      // The recorded box is the strongest provenance available, so prefer
      // its labels alone. An id that no longer resolves (the box was
      // revoked) or belongs to someone else falls back to the owner's union
      // rather than to nothing: those are still labels this database can
      // vouch for, and a revoked box is exactly the case with baked titles
      // left behind.
      const own = row.agent_device_id == null ? null : byDevice.get(row.agent_device_id)
      const labels = own && own.userId === row.owner_user_id ? own.labels : byUser.get(row.owner_user_id)
      const next = stripServerLabel(row.title, labels)
      if (next === row.title) continue
      update.run(next, row.id)
      healed++
      log(`heal-titles: ${row.id} ${JSON.stringify(row.title)} -> ${JSON.stringify(next)}`)
    }
    db.pragma('user_version = 1')
  })
  run()
  return { scanned: rows.length, healed }
}
