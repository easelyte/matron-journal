// Daily re-read of every linked user's GitHub org memberships (spec
// 2026-09-23 tracker web/teams, "Refresh"). Same shape as scheduleRetention:
// run once at start, then on an unref'd interval; every failure is logged
// and never throws out of the tick.
import { listGithubAccounts } from './github-accounts.js'
import { refreshGithubAccount } from './github-http.js'
import { PLAIN_BOX } from './token-box.js'

export const GITHUB_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function runGithubRefresh(db, github, { now = Date.now(), log = console.log, box = PLAIN_BOX } = {}) {
  const out = { refreshed: 0, stale: 0, unchanged: 0 }
  for (const acct of listGithubAccounts(db)) {
    let r
    try {
      r = await refreshGithubAccount(db, github, acct.user_id, now, { box })
    } catch (err) {
      log(`github-refresh: user=${acct.user_id} failed: ${err.message}`)
      out.unchanged++
      continue
    }
    if (!r) continue
    if (r.outcome === 'ok') out.refreshed++
    else if (r.outcome === 'stale') { out.stale++; log(`github-refresh: user=${acct.user_id} token refused, link marked stale`) }
    else if (r.error && (r.error.code === 'token_sealed' || r.error.code === 'token_unreadable')) {
      // A box-open failure, not a network failure: the token itself is
      // encrypted under a key this process does not hold. Say so distinctly
      // so it reads as "re-link this user", not "GitHub is unreachable".
      out.unchanged++
      log(`github-refresh: user=${acct.user_id} token unreadable (${r.error.code}), memberships kept`)
    } else { out.unchanged++; log(`github-refresh: user=${acct.user_id} unreachable (${r.error && r.error.code}), memberships kept`) }
  }
  return out
}

export function scheduleGithubRefresh(db, github, { intervalMs = GITHUB_REFRESH_INTERVAL_MS, log = console.log, box = PLAIN_BOX } = {}) {
  if (!github || !github.enabled) return null
  // Single flight: a run that is still walking accounts (slow GitHub, many
  // users) is never overlapped by the next tick; the tick is skipped and
  // logged instead of piling up concurrent walks over the same rows.
  let running = false
  const run = async () => {
    if (running) { log('github-refresh: previous run still in progress, skipping this tick'); return }
    running = true
    try { await runGithubRefresh(db, github, { log, box }) } catch (err) { console.error('github-refresh: run failed', err) } finally { running = false }
  }
  run()
  const interval = setInterval(run, intervalMs)
  interval.unref()
  return interval
}
