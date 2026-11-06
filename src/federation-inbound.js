// The inbound federation endpoint (docs/protocol.md "Federation": receiving
// an op). `POST /federation/v1` takes one signed envelope from another
// journal and applies its op at most once, under the delivery rules:
//
//   1. The body is read as bytes (at most 1 MiB) and parsed strictly.
//   2. `to` must name a user of this journal, and `from` a journal this one
//      knows (fed_peers, 'active'), whose pinned key must verify `sig`.
//   3. The attempt must be fresh (±5 min); 'stale' answers with our clock.
//   4. In one transaction: an `id` this peer already used is answered from
//      its receipt when {op, body} hash alike (nothing is applied again), or
//      `409 id_reused` when they differ. Otherwise the op applies and its
//      receipt is written in the same transaction, so a crash can never
//      leave an op applied without a receipt, or the reverse.
//
// A refusal (any 4xx) writes no receipt: a resend of the same op is judged
// afresh against the state at that time, which is rule 4 (authority is
// checked when an op applies). Every answer from step 2 on is signed with
// this journal's key (RESPONSE_SIG_HEADER), so a sender can tell a real
// acknowledgement from a proxy's error page.
//
// Ops register a sync `apply({db, envelope, peer, now})` that returns the
// result object, or throws Error(code) for a refusal named in its `errors`
// map (code -> status). An optional `after({db, envelope, peer, result,
// now})` runs once the transaction has committed, and only when the op was
// applied (not for an answer from a receipt): the place for side effects
// that reach users (cards, notices, live frames).
//
// Discovery. An op may name a journal this one has never seen, or one whose
// key no longer verifies: `contact.accept_invite`, the answer to an invite
// this journal minted. Such an op registers `admits({db, envelope, now})`,
// a cheap check that the envelope carries something this journal handed
// out (an open invite for `to`). Only then is the sender's well-known
// fetched (through the destination policy), the envelope verified against
// the key it serves, and the op applied with `peer.discovered` set: the
// op's own apply pins that key. Every other envelope from an unknown
// journal is refused before any work.

import { MAX_ENVELOPE_BYTES, opHash, parseEnvelope, RESPONSE_SIG_HEADER, signResponse, verifyEnvelope, importPublicKey } from './federation-envelope.js'
import { journalAllowed } from './federation-identity.js'

export const FEDERATION_PATH = '/federation/v1'
export const RECEIPT_TTL_MS = 30 * 24 * 3600 * 1000

export const PING_OP = {
  apply: ({ now }) => ({ pong: true, clock: now }),
  errors: {},
}

export const DEFAULT_OPS = { ping: PING_OP }

const readBytes = (req, maxBytes) => new Promise((resolve, reject) => {
  const chunks = []
  let bytes = 0
  let settled = false
  req.on('data', (c) => {
    bytes += c.length
    if (bytes > maxBytes) {
      settled = true
      req.removeAllListeners('data')
      req.pause()
      reject(new Error('too_large'))
      return
    }
    chunks.push(c)
  })
  req.on('end', () => { if (!settled) { settled = true; resolve(Buffer.concat(chunks)) } })
  req.on('error', (e) => { if (!settled) { settled = true; reject(e) } })
})

const hostOf = (address) => address.slice(address.indexOf('@') + 1)
const nameOf = (address) => address.slice(0, address.indexOf('@'))

export function pruneReceipts(db, now = Date.now()) {
  return db.prepare('DELETE FROM fed_receipts WHERE created_at < ?').run(now - RECEIPT_TTL_MS).changes
}

export function makeFederationHandler({ db, federation, ops = DEFAULT_OPS, client = null, now = Date.now, log = console }) {
  const findPeer = db.prepare('SELECT host, key_pub, state FROM fed_peers WHERE host=?')
  const findUser = db.prepare('SELECT id FROM users WHERE name=?')
  const findReceipt = db.prepare('SELECT hash, status, response FROM fed_receipts WHERE peer_key=? AND id=?')
  const putReceipt = db.prepare('INSERT INTO fed_receipts(peer_key, id, hash, status, response, created_at) VALUES(?,?,?,?,?,?)')
  const touchPeer = db.prepare('UPDATE fed_peers SET last_ok_at=? WHERE host=?')
  const keys = new Map()
  const keyFor = (pub) => {
    if (!keys.has(pub)) keys.set(pub, importPublicKey(pub))
    return keys.get(pub)
  }

  // `unread`: the answer goes before the body was read to its end (off,
  // wrong method, too large). The connection is closed once the answer is
  // flushed, so an unbounded body is never drained and no leftover bytes
  // desync the next request on a keep-alive socket (as http.js rejectEarly).
  const send = (res, status, body, id = null, { req = null } = {}) => {
    const text = JSON.stringify(body)
    const headers = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(text)), 'cache-control': 'no-store' }
    if (req) {
      headers.connection = 'close'
      res.on('finish', () => req.destroy())
    }
    if (id) headers[RESPONSE_SIG_HEADER] = signResponse({ id, status, body }, federation.key.privateKey)
    res.writeHead(status, headers)
    res.end(text)
  }

  return async function handleFederation(req, res, url) {
    if (url.pathname !== FEDERATION_PATH) return false
    if (!federation?.enabled) { send(res, 404, { error: 'not_found' }, null, { req }); return true }
    if (req.method !== 'POST') { res.setHeader('allow', 'POST'); send(res, 405, { error: 'method_not_allowed' }, null, { req }); return true }

    let envelope
    try {
      envelope = parseEnvelope(await readBytes(req, MAX_ENVELOPE_BYTES))
    } catch (err) {
      const code = err.message === 'too_large' ? 'too_large' : err.message === 'unsupported_version' ? 'unsupported_version' : 'malformed'
      send(res, code === 'too_large' ? 413 : 400, { error: code }, null, code === 'too_large' ? { req } : {})
      return true
    }
    const { id } = envelope

    if (hostOf(envelope.to) !== federation.host || !findUser.get(nameOf(envelope.to))) {
      send(res, 403, { error: 'not_here' }, id)
      return true
    }
    const host = hostOf(envelope.from)
    if (!journalAllowed(federation, host)) { send(res, 403, { error: 'peer_refused' }, id); return true }
    const handler = Object.hasOwn(ops, envelope.op) ? ops[envelope.op] : null
    const known = findPeer.get(host)
    if (known?.state === 'blocked') { send(res, 403, { error: 'peer_refused' }, id); return true }

    const at = now()
    let peer = null
    if (known?.state === 'active') {
      try {
        verifyEnvelope(envelope, keyFor(known.key_pub), { now: at })
        peer = known
      } catch (err) {
        if (err.message === 'stale') { send(res, 401, { error: 'stale', clock: err.clock }, id); return true }
        // A bad signature from a known journal may still be an invite's
        // answer from a journal whose key changed: discovery decides.
      }
    }
    if (!peer) {
      let admitted = false
      if (handler?.admits && client) {
        try { admitted = !!handler.admits({ db, envelope, now: at }) } catch (err) { log.error(`federation: ${envelope.op} admits check failed`, err) }
      }
      if (!admitted) {
        const error = !known ? 'unknown_journal' : known.state !== 'active' ? 'peer_refused' : 'bad_signature'
        send(res, 403, { error }, id)
        return true
      }
      let wk
      try {
        wk = await client.fetchWellKnown(host)
      } catch (err) {
        // Ours to retry, not theirs to give up on: a 503 is retried.
        send(res, 503, { error: 'peer_unreachable', why: err.why ?? err.message }, id)
        return true
      }
      if (known?.state === 'active' && wk.pub === known.key_pub) { send(res, 403, { error: 'bad_signature' }, id); return true }
      try {
        verifyEnvelope(envelope, wk.publicKey, { now: at })
      } catch (err) {
        if (err.message === 'stale') send(res, 401, { error: 'stale', clock: err.clock }, id)
        else send(res, 403, { error: 'bad_signature' }, id)
        return true
      }
      peer = { host, base_url: wk.baseUrl, key_pub: wk.pub, state: 'active', discovered: true, previous: known ?? null }
    }
    // The fetch took time: what the op checks (an invite's expiry) is judged
    // now, not when the envelope arrived.
    const applyAt = peer.discovered ? now() : at

    if (!handler) { send(res, 400, { error: 'unknown_op' }, id); return true }

    const hash = opHash(envelope)
    let answer
    try {
      answer = db.transaction(() => {
        const prior = findReceipt.get(peer.key_pub, id)
        if (prior) {
          if (prior.hash !== hash) return { status: 409, body: { error: 'id_reused' } }
          return { status: prior.status, body: JSON.parse(prior.response) }
        }
        const result = handler.apply({ db, envelope, peer, now: applyAt })
        const body = { ok: true, result: result ?? {} }
        putReceipt.run(peer.key_pub, id, hash, 200, JSON.stringify(body), applyAt)
        touchPeer.run(applyAt, peer.host)
        return { status: 200, body, applied: true, result: result ?? {} }
      })()
    } catch (err) {
      const status = handler.errors?.[err.message]
      if (!status) throw err
      answer = { status, body: { error: err.message } }
    }
    send(res, answer.status, answer.body, id)
    if (answer.applied && handler.after) {
      try { handler.after({ db, envelope, peer, result: answer.result, now: applyAt }) } catch (err) { log.error(`federation: ${envelope.op} after hook failed (the op stands)`, err) }
    }
    return true
  }
}
