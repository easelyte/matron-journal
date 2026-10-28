// HTTP surface of the per-box defaults for new sessions (src/box-defaults.js).
// Either device kind may read and write, like /defaults: the apps' Settings
// ▸ Devices set them, and so does the Coordinator from chat through its own
// bridge's token — for any of the user's agent boxes, not only its own,
// except that an ordinary (non-private) agent never sees or changes a
// private box: to it a private device is the same 404 as an unknown id
// (docs/protocol.md "Device privacy"). A
// change goes live as {kind:'box_defaults'} to the user's apps and to that
// box's own sockets; nothing is journaled — a bridge reads its values from
// hello_ok on every connect, so there is nothing to replay.
import { json, readBody } from './http-body.js'
import { badRequest } from './http-who.js'
import { normaliseModel } from './defaults.js'
import { getBoxDefaults, setBoxDefaults, normaliseAgent, normaliseBoxEffort } from './box-defaults.js'
import { isPrivateDevice } from './db.js'
import { filteredAgent } from './privacy.js'

const KEYS = ['default_agent', 'default_model', 'default_effort']
const CHECKS = [['default_agent', normaliseAgent, 'bad_agent'], ['default_model', normaliseModel, 'bad_model'], ['default_effort', normaliseBoxEffort, 'bad_effort']]

export async function handleBoxDefaultsRoute(ctx, req, res, url, who) {
  const m = url.pathname.match(/^\/devices\/(\d+)\/defaults$/)
  if (!m || (req.method !== 'GET' && req.method !== 'PUT')) return false
  const { db, hub } = ctx
  const deviceId = Number(m[1])
  // Unknown and another user's device are one 404 (anti-enumeration, as the
  // rename and tag routes); the user's own client device is told plainly.
  const device = db.prepare('SELECT kind FROM devices WHERE id=? AND user_id=?').get(deviceId, who.userId)
  if (!device || (filteredAgent(db, who) && isPrivateDevice(db, deviceId))) { json(res, 404, { error: 'not_found' }); return true }
  if (device.kind !== 'agent') { json(res, 400, { error: 'not_agent_device' }); return true }
  if (req.method === 'GET') {
    json(res, 200, { device_id: deviceId, ...getBoxDefaults(db, who.userId, deviceId) })
    return true
  }
  const body = await readBody(req)
  if (Object.keys(body).some((k) => !KEYS.includes(k))) return badRequest(res)
  // Every value checked before anything is written: one bad field is a 400
  // that leaves the box as it was.
  const patch = {}
  for (const [key, normalise, error] of CHECKS) {
    if (!(key in body)) continue
    patch[key] = normalise(body[key])
    if (patch[key] === undefined) { json(res, 400, { error }); return true }
  }
  const r = setBoxDefaults(db, who.userId, deviceId, patch)
  // The row was checked above; only a revoke landing in between gets here.
  if (!r) { json(res, 404, { error: 'not_found' }); return true }
  if (r.changed) {
    const frame = { kind: 'box_defaults', device_id: deviceId, ...r.defaults }
    try {
      hub.sendToClients(who.userId, frame)
      hub.sendToDevice(who.userId, deviceId, frame)
    } catch (err) { console.error('box defaults: live frame failed (saved)', err) }
  }
  json(res, 200, { device_id: deviceId, ...r.defaults })
  return true
}
