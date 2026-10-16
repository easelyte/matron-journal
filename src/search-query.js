// Query parsing shared by every tracker search tier (spec 2026-10-12
// unified search §3). A literal query is one where a fuzzy match is noise:
// quoted, carrying a number or an id-like token, or a single word.
const ID_LIKE = /^(?=.*\p{L})(?=.*\p{N})[\p{L}\p{N}_-]{8,}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-/i

export function parseQuery(raw) {
  const text = String(raw).trim()
  const quoted = /^".+"$/.test(text)
  const inner = quoted ? text.slice(1, -1) : text
  const terms = inner.split(/\s+/).map((t) => t.replace(/^[^\p{L}\p{N}#]+|[^\p{L}\p{N}]+$/gu, '')).filter((t) => /[\p{L}\p{N}]/u.test(t))
  if (terms.length === 0) return null
  const literal = quoted || terms.length === 1 || terms.some((t) => /\p{N}/u.test(t) || ID_LIKE.test(t) || UUID.test(t))
  return { terms, phrase: terms.join(' '), literal, quoted }
}

const q = (t) => `"${t.replace(/"/g, '""')}"`
export const matchExact = (p) => q(p.phrase)
export const matchAll = (p) => p.terms.map(q).join(' ')
export const matchAny = (p) => p.terms.map(q).join(' OR ')
