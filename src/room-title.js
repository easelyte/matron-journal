// Titles for the rooms the journal itself mints — today only the spawn
// room approveSpawn (src/spawns.js) opens between a parent session and the
// child it started. The shape is the bridge's own agent-chat room title
// (matron-bridge lib/agent-chat.js chatStart), copied here so a spawn room
// reads exactly like every other room in the chat list:
//
//   `D:ab ↔️ E:cd — topic`
//
// Each side is the `Letter:short` tag the apps render beside every chat
// (MatronShared SessionTag): the box letter derived from the box-name
// registry plus the session short the owning bridge baked into that
// session's title. A side whose short is not known yet (the child before
// its bridge has published a title, a parent whose title never earned one)
// falls back to the plain device name, the same fallback chatStart uses —
// a bare `D:` says nothing.
//
// Two helpers are direct ports of the bridge's (lib/box-letters.js and
// lib/journal-title-seed.js sessionShortFromTitle), which are themselves
// ports of MatronShared SessionTag. Three copies of one rule: if it changes,
// it changes everywhere or the journal's baked tag contradicts the coloured
// one the app draws beside it.

// Same cap as the bridge's ROOM_TITLE_MAX.
export const ROOM_TITLE_MAX = 120

// The first letter or digit, uppercased. Uppercasing can EXPAND some letters
// (ß → SS); the tag is one character by contract, so keep the original when
// it does. Iterated by code point so an astral character is never split.
function firstAlphanumeric(s) {
  for (const ch of s) {
    if (!/[\p{L}\p{N}]/u.test(ch)) continue
    const upper = ch.toUpperCase()
    return [...upper].length === 1 ? upper : ch
  }
  return null
}

// Length of the case-insensitive longest common prefix of every name.
function commonPrefixLength(names) {
  if (names.length < 2) return 0
  const shortest = names.reduce((a, b) => (b.length < a.length ? b : a))
  for (let len = shortest.length; len > 0; len--) {
    const candidate = shortest.slice(0, len).toLowerCase()
    if (names.every((n) => n.toLowerCase().startsWith(candidate))) return len
  }
  return 0
}

// One display letter per box name, in the same order. Strip the prefix
// common to ALL names, then take the first letter/digit of what remains,
// uppercased — `dev-y` / `dev-z` come out `Y` / `Z`, not both `D`. A name
// that IS the common prefix falls back to its own initial; a name with no
// usable character comes back `?`. A nameless entry is left out of the strip
// so one unnamed box cannot restyle the others.
export function boxLetters(names = []) {
  const named = names.filter((n) => typeof n === 'string' && n.length > 0)
  const prefixLength = commonPrefixLength(named)
  return names.map((name) => {
    if (typeof name !== 'string' || !name) return '?'
    return firstAlphanumeric(name.slice(prefixLength)) || firstAlphanumeric(name) || '?'
  })
}

// One name's letter against the whole roster it belongs to. `override` is
// the device's tag_char (Settings → Devices → Tag Character), applied AFTER
// derivation so one box opting out never shifts its neighbours' letters.
export function boxLetterFor(name, names = [], override = null) {
  if (typeof override === 'string' && override.trim()) return override.trim()
  const set = names.includes(name) ? names : [...names, name]
  return boxLetters(set)[set.indexOf(name)]
}

// Every marker a bridge may put AHEAD of the short in a title: ↔️ / 🔗 for a
// room (🔗 is the legacy form; titles only rewrite on rename, so it must
// keep parsing) and 🐣 for a spawned session.
const TITLE_MARKERS = ['↔️ ', '🔗 ', '🐣 ']

// The session short a bridge baked into a published title (`[ab] Title`,
// or behind a marker), or '' when the title never earned one. Same closed
// shape the apps parse: exactly two alphanumerics in brackets, one space,
// then a non-empty title — `[WIP] ship it` is never mistaken for a short.
export function sessionShortFromTitle(raw) {
  if (typeof raw !== 'string') return ''
  const marker = TITLE_MARKERS.find((m) => raw.startsWith(m))
  if (marker) return sessionShortFromTitle(raw.slice(marker.length))
  return /^\[([\p{L}\p{N}]{2})\] .+$/u.exec(raw)?.[1] || ''
}

// One side of a room title: `Letter:short` when the short is known, else
// the plain label. `names` is the whole box-name set the letter is struck
// against (see boxLetterFor).
export function sideTag({ name, short, names, override = null, label = name }) {
  return short && name ? `${boxLetterFor(name, names, override)}:${short}` : label
}

export function roomTitle(selfTag, peerTag, topic = '') {
  return `${selfTag} ↔️ ${peerTag}${topic ? ` — ${topic}` : ''}`.slice(0, ROOM_TITLE_MAX)
}
