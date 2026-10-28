// HTTP surface of src/settings.js. Either device kind may read (a bridge
// reads `notices` to decide what new sessions are told); only the user — a
// client token — may change it. A change goes live to every connected
// device, agents included, as {kind:'control', op:'settings'}: nothing to
// replay, since hello_ok carries the current view on every connect.
import { json, readBody } from './http-body.js'
import { badRequest } from './http-who.js'
import { settingsView, setNoticesEnabled, setAutoApproveCoordinatorSpawns } from './settings.js'
import { isAutoArchiveDays, setAutoArchiveDays } from './archive.js'

export const SETTINGS_KEYS = ['notices', 'auto_approve_coordinator_spawns', 'auto_archive_days']

export async function handleSettingsRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/settings') return false
  const { db, hub } = ctx
  if (req.method === 'GET') {
    json(res, 200, settingsView(db, who.userId))
    return true
  }
  if (req.method !== 'PATCH' && req.method !== 'PUT') return false
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }
  const body = await readBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res)
  const keys = Object.keys(body)
  if (!keys.length || keys.some((k) => !SETTINGS_KEYS.includes(k))) return badRequest(res)
  if ('notices' in body && typeof body.notices !== 'boolean') return badRequest(res)
  if ('auto_approve_coordinator_spawns' in body && typeof body.auto_approve_coordinator_spawns !== 'boolean') return badRequest(res)
  if ('auto_archive_days' in body && !isAutoArchiveDays(body.auto_archive_days)) return badRequest(res)
  const now = Date.now()
  db.transaction(() => {
    if ('notices' in body) setNoticesEnabled(db, who.userId, body.notices, now)
    if ('auto_approve_coordinator_spawns' in body) setAutoApproveCoordinatorSpawns(db, who.userId, body.auto_approve_coordinator_spawns, now)
    if ('auto_archive_days' in body) setAutoArchiveDays(db, who.userId, body.auto_archive_days, now)
  })()
  const view = settingsView(db, who.userId)
  for (const c of hub.connsOf(who.userId)) {
    if (c.ws.readyState === 1) c.ws.send(JSON.stringify({ kind: 'control', op: 'settings', settings: view }))
  }
  json(res, 200, view)
  return true
}
