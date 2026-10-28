// POST /summarise — a conversation title or rolling summary, written by the
// journal's own model key for the bridge that asks (src/summarise.js).
//
//   POST /summarise   Authorization: Bearer <agent device token>
//   {system?: string, prompt: string}
//   -> 200 {text, model, usage: {inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens}}
//
// Agent devices only: a bridge already holds its device token for every
// other call it makes here. A client (app) token is 403 forbidden; no token
// is the chain's usual 401 unauthenticated. Other answers:
//   400 bad_request           prompt missing, empty or not a string; system not a string
//   413 too_large             system over 16 KiB or prompt over 256 KiB (UTF-8 bytes)
//   429 rate_limited          this device spent its hourly budget, or the
//                             journal is at its concurrent-call cap; Retry-After in seconds
//   502 upstream_failed       any upstream error, timeout or unusable completion
//   503 summariser_unavailable no key configured on the journal host, or
//                             MATRON_SUMMARY_USERS is set and the device's
//                             user is not on it (503, not 403: a bridge backs
//                             off on 503 instead of retrying every summary)
//
// Privacy: the prompt is the calling device's own conversation text, and
// the completion goes back to that device and nowhere else. Nothing is
// stored, journaled or broadcast, and neither the prompt nor any upstream
// body is logged (src/summarise.js says which calls get a log line) — so a
// private device's content is never shown to another device by this route,
// and the private-device rules (src/privacy.js) have nothing here to filter.
import { json, readBody } from './http-body.js'
import { badRequest } from './http-who.js'

export const SUMMARISE_PATH = '/summarise'
export const SYSTEM_MAX_BYTES = 16 * 1024
export const PROMPT_MAX_BYTES = 256 * 1024
// The whole body, JSON escaping included: room for both fields at their
// caps even when every character of them is escaped.
export const SUMMARISE_BODY_MAX = 2 * 1024 * 1024

export async function handleSummariseRoute(ctx, req, res, url, who, { rejectEarly }) {
  if (url.pathname !== SUMMARISE_PATH || req.method !== 'POST') return false
  const { db, summariser } = ctx
  if (who.kind !== 'agent') { rejectEarly(req, res, 403, { error: 'forbidden' }); return true }
  if (!summariser) { rejectEarly(req, res, 503, { error: 'summariser_unavailable' }); return true }
  // `who` carries the user id; the allow-list is of names (users.name is
  // unique), looked up per call so a user added later is matched too.
  const userName = db.prepare('SELECT name FROM users WHERE id=?').get(who.userId)?.name
  if (!summariser.allows(who, userName)) { rejectEarly(req, res, 503, { error: 'summariser_unavailable' }); return true }
  const body = await readBody(req, { maxBytes: SUMMARISE_BODY_MAX })
  const { system = null, prompt } = body
  if (typeof prompt !== 'string' || !prompt) return badRequest(res)
  if (system !== null && typeof system !== 'string') return badRequest(res)
  if (Buffer.byteLength(prompt, 'utf8') > PROMPT_MAX_BYTES || (system && Buffer.byteLength(system, 'utf8') > SYSTEM_MAX_BYTES)) {
    json(res, 413, { error: 'too_large' })
    return true
  }
  const r = await summariser.summarise(who, { system: system || null, prompt })
  if (r.status === 'ok') {
    json(res, 200, { text: r.text, model: r.model, usage: r.usage })
  } else if (r.status === 'rate_limited' || r.status === 'busy') {
    res.setHeader('Retry-After', String(r.retryAfter))
    json(res, 429, { error: 'rate_limited' })
  } else {
    json(res, 502, { error: 'upstream_failed' })
  }
  return true
}
