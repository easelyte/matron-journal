import crypto from 'node:crypto'
import https from 'node:https'
import dns from 'node:dns/promises'
import fs from 'node:fs'
import net from 'node:net'

function decodeKey(value, length) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('invalid key')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== length) throw new Error('invalid key length')
  return bytes
}

export function encryptPayload({ payload, p256dh, auth, salt = crypto.randomBytes(16), ephemeral }) {
  if (!Buffer.isBuffer(payload) || payload.length > 3993 || salt.length !== 16) throw new Error('invalid payload')
  const receiver = decodeKey(p256dh, 65)
  if (receiver[0] !== 4) throw new Error('invalid point')
  const secret = decodeKey(auth, 16)
  const sender = crypto.createECDH('prime256v1')
  if (ephemeral) sender.setPrivateKey(ephemeral.privateKey)
  else sender.generateKeys()
  const publicKey = sender.getPublicKey()
  if (ephemeral && !publicKey.equals(ephemeral.publicKey)) throw new Error('invalid ephemeral key')
  const info = Buffer.concat([Buffer.from('WebPush: info\0'), receiver, publicKey])
  const ikm = crypto.hkdfSync('sha256', sender.computeSecret(receiver), secret, info, 32)
  const key = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = crypto.hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = crypto.createCipheriv('aes-128-gcm', key, nonce)
  const header = Buffer.alloc(5)
  header.writeUInt32BE(4096)
  header[4] = 65
  return Buffer.concat([salt, header, publicKey, cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()])
}

export function vapidAuthorization({ endpoint, privateKey, publicKeyB64u, subject, now = Date.now(), ttlSeconds = 12 * 3600 }) {
  const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64url')
  const input = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + Math.min(86400, ttlSeconds), sub: subject })}`
  const signature = crypto.sign('sha256', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')
  return `vapid t=${input}.${signature}, k=${publicKeyB64u}`
}

function publicV4(ip) {
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip)) return false
  const parts = ip.split('.').map(Number)
  if (parts.some((p) => p > 255) || ip.split('.').some((p) => p.length > 1 && p[0] === '0')) return false
  const [a, b, c] = parts
  return !(a === 0 || a === 10 || a === 127 || a >= 224
    || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99)))
    || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
    || (a === 203 && b === 0 && c === 113))
}

export function isPublicAddress(ip) {
  if (typeof ip !== 'string' || !/^[A-Fa-f0-9:.]+$/.test(ip)) return false
  if (!ip.includes(':')) return publicV4(ip)
  try {
    const normalized = new URL(`https://[${ip}]/`).hostname.slice(1, -1)
    const halves = normalized.split('::')
    const left = halves[0] ? halves[0].split(':') : []
    const right = halves.length > 1 && halves[1] ? halves[1].split(':') : []
    const words = halves.length === 1 ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    if (words.length !== 8) return false
    const w = words.map((s) => parseInt(s, 16))
    // ::ffff:0:a.b.c.d (SIIT) wraps a v4 address too.
    if (w.slice(0, 4).every((n) => n === 0) && w[4] === 0xffff && w[5] === 0) return publicV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`)
    const embedded = w.slice(0, 5).every((n) => n === 0) && (w[5] === 0 || w[5] === 0xffff)
      || (w[0] === 0x64 && w[1] === 0xff9b && w.slice(2, 6).every((n) => n === 0))
    if (embedded) return publicV4(`${w[6] >> 8}.${w[6] & 255}.${w[7] >> 8}.${w[7] & 255}`)
    return !((w[0] & 0xfe00) === 0xfc00 || (w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0 || (w[0] & 0xff00) === 0xff00
      || (w[0] === 0x2001 && (w[1] === 0xdb8 || w[1] === 0)) // documentation, Teredo
      || w[0] === 0x2002 // 6to4 wraps a v4 address
      || (w[0] === 0x64 && w[1] === 0xff9b && w[2] === 1) // local-use NAT64
      || (w[0] === 0x100 && w.slice(1, 4).every((n) => n === 0))) // discard-only
  } catch { return false }
}

const defaultHosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', '*.push.apple.com', '*.notify.windows.com']

function normalizeExtraHosts(entries) {
  return entries.map((entry) => entry.trim().toLowerCase()).filter(Boolean).map((entry) => {
    const host = entry.startsWith('*.') ? entry.slice(2) : entry
    if (host.length > 253 || !host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
      throw new Error('Invalid MATRON_WEBPUSH_EXTRA_HOSTS entry')
    }
    return entry
  })
}

function matchesHost(host, entry) {
  return entry.startsWith('*.') ? host.endsWith(entry.slice(1)) : host === entry
}

export function checkEndpoint(value, extraHosts = []) {
  if (typeof value !== 'string' || value.length > 2048) return { ok: false, reason: 'bad_endpoint' }
  try {
    const url = new URL(value)
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase()
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')
      || host === 'localhost' || /\.(localhost|local|internal)$/.test(host)
      || ((host.includes(':') || /^[\d.]+$/.test(host)) && !isPublicAddress(host))) return { ok: false, reason: 'bad_endpoint' }
    const extras = normalizeExtraHosts(extraHosts)
    const literal = net.isIP(host) !== 0
    if (literal ? !extras.includes(host) : ![...defaultHosts, ...extras].some((entry) => matchesHost(host, entry))) {
      return { ok: false, reason: 'bad_endpoint' }
    }
    return { ok: true, url }
  } catch { return { ok: false, reason: 'bad_endpoint' } }
}

function defaultRequest({ address, family, hostname, port, path, headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, port, path, method: 'POST', headers: { ...headers, Host: hostname.includes(':') ? `[${hostname}]` : hostname },
      ...(net.isIP(hostname) ? {} : { servername: hostname }), agent: false,
      // Pin the connection to the answer already checked, including when Node asks for all answers.
      lookup: (_host, options, callback) => callback(null, options?.all ? [{ address, family }] : address, family),
    }, (res) => {
      let bytes = 0
      res.on('data', (chunk) => {
        bytes += chunk.length
        if (bytes > 4096) res.destroy()
      })
      res.on('error', reject)
      res.on('close', () => resolve({ status: res.statusCode, headers: res.headers }))
      res.resume()
    })
    const timer = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs)
    req.on('close', () => clearTimeout(timer))
    req.on('error', reject)
    req.end(body)
  })
}

export function makeWebPushClient({ privateKeyFile, subject, extraHosts = [], lookup = dns.lookup, request = defaultRequest, now = Date.now, timeoutMs = 10000 }) {
  const hosts = normalizeExtraHosts(extraHosts)
  const check = (value) => checkEndpoint(value, hosts)
  const privateKey = crypto.createPrivateKey(fs.readFileSync(privateKeyFile))
  if (privateKey.asymmetricKeyType !== 'ec' || privateKey.asymmetricKeyDetails?.namedCurve !== 'prime256v1') throw new Error('VAPID key must be P-256')
  const subjectUrl = new URL(subject)
  if (!['mailto:', 'https:'].includes(subjectUrl.protocol)) throw new Error('VAPID subject must be mailto: or https:')
  const jwk = crypto.createPublicKey(privateKey).export({ format: 'jwk' })
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]).toString('base64url')
  let closed = false
  return {
    publicKey,
    checkEndpoint: check,
    async send({ endpoint, p256dh, auth, payload, urgency, topic, ttl }) {
      try {
        if (closed) return { status: 0, reason: 'closed' }
        const checked = check(endpoint)
        if (!checked.ok) return { status: 0, reason: checked.reason }
        let body
        try { body = encryptPayload({ payload, p256dh, auth }) } catch { return { status: 0, reason: 'encrypt_failed' } }
        const hostname = checked.url.hostname.replace(/^\[|\]$/g, '')
        // getaddrinfo runs on the shared threadpool and has no timeout of its own, so a
        // nameserver that never answers must not hold a thread for every push.
        let timer
        const answers = await Promise.race([
          lookup(hostname, { all: true }),
          new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('dns timeout')), timeoutMs) }),
        ]).finally(() => clearTimeout(timer))
        if (!answers.length || answers.some((a) => !isPublicAddress(a.address))) return { status: 0, reason: 'blocked_address' }
        const headers = {
          TTL: ttl, 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream', 'Content-Length': body.length,
          Authorization: vapidAuthorization({ endpoint, privateKey, publicKeyB64u: publicKey, subject, now: now() }),
          Urgency: urgency === 'high' ? 'high' : 'normal', ...(topic ? { Topic: topic } : {}),
        }
        const { status } = await request({ address: answers[0].address, family: answers[0].family, hostname, port: 443, path: checked.url.pathname + checked.url.search, headers, body, timeoutMs })
        if (status >= 200 && status < 300) return { status }
        return { status, reason: status >= 300 && status < 400 ? 'redirect' : 'http_error' }
      } catch { return { status: 0, reason: 'transport' } }
    },
    close() { closed = true },
  }
}

export function webPushConfigFromEnv(env) {
  const extraHosts = normalizeExtraHosts((env.MATRON_WEBPUSH_EXTRA_HOSTS || '').split(','))
  const kill = env.MATRON_WEBPUSH_DISABLED
  if (kill === '1' || kill === 'true') return null
  if (kill !== undefined && kill !== '' && kill !== '0' && kill !== 'false') throw new Error('MATRON_WEBPUSH_DISABLED must be 1, true, 0 or false')
  const privateKeyFile = env.MATRON_WEBPUSH_VAPID_KEY_FILE
  const subject = env.MATRON_WEBPUSH_SUBJECT
  if (!privateKeyFile && !subject) return null
  if (!privateKeyFile) throw new Error('Missing MATRON_WEBPUSH_VAPID_KEY_FILE')
  if (!subject) throw new Error('Missing MATRON_WEBPUSH_SUBJECT')
  return { privateKeyFile, subject, extraHosts }
}
