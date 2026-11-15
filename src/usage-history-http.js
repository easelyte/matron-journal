// GET /usage/history?weeks=N — each account's weekly meters over the last N
// weeks (default 12, at most 104): per finished week the last reading before
// the reset and the allowance left unused, plus the week in progress
// (src/usage-history.js). Open to either device kind: the apps' Boxes screen
// shows it, and an agent reads it to report on spare allowance. An ordinary
// (non-private) agent never sees what only a private box reported
// (docs/protocol.md "Device privacy").
import { json } from './http-body.js'
import { badRequest } from './http-who.js'
import { filteredAgent } from './privacy.js'
import { readUsageHistory, WEEKS_DEFAULT, WEEKS_MAX } from './usage-history.js'

export function handleUsageHistoryRoute(ctx, req, res, url, who) {
  if (req.method !== 'GET' || url.pathname !== '/usage/history') return false
  let weeks = WEEKS_DEFAULT
  const raw = url.searchParams.get('weeks')
  if (raw !== null) {
    if (!/^\d{1,3}$/.test(raw) || Number(raw) < 1 || Number(raw) > WEEKS_MAX) return badRequest(res)
    weeks = Number(raw)
  }
  json(res, 200, readUsageHistory(ctx.db, who.userId, { weeks, excludePrivate: filteredAgent(ctx.db, who) }))
  return true
}
