// Canonical repo identity as reported by a bridge on convo_upsert (spec
// 2026-09-23 tracker web/teams, "Repo identity"): `host/org/name`, host and
// org lower-cased, name as-is. The journal never sees a git URL — the bridge
// normalises — so this is a validator and splitter, not a URL parser.
export const REPO_MAX = 256
export const REPO_RE = /^[a-z0-9.-]+\/[a-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

// Returns null for anything that is not a canonical repo string.
export function parseRepo(s) {
  if (typeof s !== 'string' || s.length === 0 || s.length > REPO_MAX || !REPO_RE.test(s)) return null
  const [host, org, name] = s.split('/')
  return { repo: s, scope: `${host}/${org}`, host, org, name }
}
