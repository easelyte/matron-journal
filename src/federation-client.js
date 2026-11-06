// Outbound HTTP to other journals (docs/protocol.md "Federation": calling
// another journal). Every request a journal makes to a peer goes through
// here, because a peer's address comes from outside: an invite link, a
// well-known document, a contact row. Without these rules a link could
// point the journal at its own loopback services, the LAN, or a cloud
// metadata endpoint.
//
//   - https only.
//   - The host is resolved once per request. Every address it resolves to
//     must be public: loopback, private, link-local, CGNAT, ULA, multicast,
//     reserved and metadata addresses are refused, and so are IPv4 addresses
//     written inside IPv6 (mapped, NAT64, 6to4). An operator lists hosts in
//     MATRON_FEDERATION_ALLOW_HOSTS to let a peer on the LAN or a tailnet
//     through.
//   - The connection goes to the address that was checked (the socket's
//     lookup is answered with it), while TLS still verifies the certificate
//     against the host name. DNS rebinding between the check and the
//     connect cannot swap it.
//   - Redirects are not followed: a 3xx is just a status.
//   - 10 s to connect, 30 s in all, and the response body capped (1 MiB
//     unless the caller says otherwise).

import dns from 'node:dns'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import {
  importPublicKey, keyFingerprint, MAX_ENVELOPE_BYTES, RESPONSE_SIG_HEADER, verifyResponse,
} from './federation-envelope.js'
import { parseStrict } from './federation-json.js'
import { WELL_KNOWN_PATH } from './federation-identity.js'

const fail = (code, extra) => { throw Object.assign(new Error(code), extra) }

const BLOCKED = new net.BlockList()
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) BLOCKED.addSubnet(net4, bits, 'ipv4')
for (const [net6, bits] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) BLOCKED.addSubnet(net6, bits, 'ipv6')

// True for an address a peer journal can never legitimately be at.
export function isBlockedAddress(address) {
  const family = net.isIP(address)
  if (family === 4) return BLOCKED.check(address, 'ipv4')
  // An IPv4-mapped address (::ffff:a.b.c.d) is refused outright: a real
  // peer never resolves to one. (It is not a BlockList subnet: BlockList
  // matches IPv4 rules against mapped addresses and the reverse, which
  // would refuse every IPv4 address.)
  if (family === 6) return /^::ffff:/i.test(address) || /^0{0,4}:0{0,4}:0{0,4}:0{0,4}:0{0,4}:ffff:/i.test(address) || BLOCKED.check(address, 'ipv6')
  return true
}

export const parseAllowHosts = (raw) => String(raw || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)

// `allowHttp` and `rewriteUrl` are test seams only: two journals in one test
// process talk over plain HTTP on loopback, and `rewriteUrl(url) -> url`
// sends the requests for a test host (`https://a.example/…`) to the
// loopback server that plays it. Nothing in production sets either.
export function makeFederationClient({
  allowHosts = [], allowHttp = false, rewriteUrl = null, lookup = dns.lookup,
  connectTimeoutMs = 10_000, totalTimeoutMs = 30_000,
} = {}) {
  const allowed = new Set(allowHosts.map((h) => h.toLowerCase()))

  // → {address, family} the request will connect to, or 'destination_refused'.
  async function resolveDestination(u) {
    if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) fail('destination_refused', { why: 'scheme' })
    if (u.username || u.password) fail('destination_refused', { why: 'credentials' })
    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase()
    let addrs
    if (net.isIP(host)) addrs = [{ address: host, family: net.isIP(host) }]
    else {
      try { addrs = await new Promise((res, rej) => lookup(host, { all: true, verbatim: true }, (e, a) => (e ? rej(e) : res(a)))) } catch {
        fail('network', { why: 'dns' })
      }
    }
    if (!addrs?.length) fail('network', { why: 'dns' })
    if (!allowed.has(host) && addrs.some((a) => isBlockedAddress(a.address))) fail('destination_refused', { why: 'address' })
    return { host, ...addrs[0] }
  }

  // One request. → {status, headers, body: Buffer}. Error codes:
  // 'destination_refused', 'network', 'timeout', 'too_large'.
  async function request(url, { method = 'GET', headers = {}, body = null, maxBytes = MAX_ENVELOPE_BYTES } = {}) {
    const u = new URL(rewriteUrl ? rewriteUrl(String(url)) : url)
    const dest = await resolveDestination(u)
    const mod = u.protocol === 'https:' ? https : http
    return new Promise((resolve, reject) => {
      let settled = false
      const done = (fn, v) => { if (!settled) { settled = true; clearTimeout(total); clearTimeout(connect); fn(v) } }
      const req = mod.request({
        protocol: u.protocol, hostname: dest.host, port: u.port || undefined, path: u.pathname + u.search, method,
        servername: net.isIP(dest.host) ? undefined : dest.host,
        headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) },
        agent: false,
        // Answer the socket's own lookup with the address that was checked.
        lookup: (_h, opts, cb) => (opts?.all ? cb(null, [{ address: dest.address, family: dest.family }]) : cb(null, dest.address, dest.family)),
      }, (res) => {
        clearTimeout(connect)
        const chunks = []
        let bytes = 0
        res.on('data', (c) => {
          bytes += c.length
          if (bytes > maxBytes) { req.destroy(); done(reject, Object.assign(new Error('too_large'))) } else chunks.push(c)
        })
        res.on('end', () => done(resolve, { status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
        res.on('error', () => done(reject, Object.assign(new Error('network'), { why: 'read' })))
      })
      const connect = setTimeout(() => { req.destroy(); done(reject, Object.assign(new Error('timeout'), { why: 'connect' })) }, connectTimeoutMs)
      const total = setTimeout(() => { req.destroy(); done(reject, Object.assign(new Error('timeout'), { why: 'total' })) }, totalTimeoutMs)
      req.on('socket', (s) => s.once(u.protocol === 'https:' ? 'secureConnect' : 'connect', () => clearTimeout(connect)))
      req.on('error', (e) => done(reject, Object.assign(new Error('network'), { why: e.code || 'socket' })))
      req.end(body || undefined)
    })
  }

  // A peer's identity document, checked: it must name the host it was
  // fetched from, and its key id must be its key's fingerprint. Error
  // codes: those of request(), plus 'bad_well_known'.
  async function fetchWellKnown(host, { scheme = 'https' } = {}) {
    const r = await request(`${scheme}://${host}${WELL_KNOWN_PATH}`, { headers: { accept: 'application/json' }, maxBytes: 64 * 1024 })
    if (r.status !== 200) fail('bad_well_known', { why: `status ${r.status}` })
    let doc
    try { doc = parseStrict(r.body) } catch { fail('bad_well_known', { why: 'json' }) }
    if (doc?.v !== 1 || doc.journal !== host.toLowerCase() || typeof doc.base_url !== 'string') fail('bad_well_known', { why: 'shape' })
    if (doc.key?.alg !== 'ed25519') fail('bad_well_known', { why: 'alg' })
    let publicKey
    try { publicKey = importPublicKey(doc.key.pub) } catch { fail('bad_well_known', { why: 'key' }) }
    if (doc.key.id !== keyFingerprint(doc.key.pub)) fail('bad_well_known', { why: 'fingerprint' })
    let base
    try { base = new URL(doc.base_url) } catch { fail('bad_well_known', { why: 'base_url' }) }
    if (base.host.toLowerCase() !== host.toLowerCase() || base.origin !== doc.base_url) fail('bad_well_known', { why: 'base_url' })
    return { journal: doc.journal, baseUrl: doc.base_url, pub: doc.key.pub, fingerprint: doc.key.id, publicKey }
  }

  // Sends one signed envelope to a peer's /federation/v1 and checks the
  // signature on its answer against the peer's pinned key. → {status, body,
  // signed}: `signed` is false when the answer carried no valid signature
  // (an error from a proxy in front of the peer, say); the caller treats
  // such an answer by its status alone and never as an acknowledgement.
  async function postEnvelope(baseUrl, envelope, peerPublicKey) {
    const r = await request(new URL('/federation/v1', baseUrl).href, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(envelope), 'utf8'),
    })
    let body = null
    try { body = parseStrict(r.body) } catch { body = null }
    const signed = body !== null && typeof body === 'object' &&
      verifyResponse({ id: envelope.id, status: r.status, body, sig: r.headers[RESPONSE_SIG_HEADER] }, peerPublicKey)
    return { status: r.status, body, signed }
  }

  return { request, fetchWellKnown, postEnvelope, resolveDestination }
}

// The client the journal itself uses, from env: MATRON_FEDERATION_ALLOW_HOSTS.
export function makeConfiguredFederationClient({ env = process.env, ...opts } = {}) {
  return makeFederationClient({ allowHosts: parseAllowHosts(env.MATRON_FEDERATION_ALLOW_HOSTS), ...opts })
}
