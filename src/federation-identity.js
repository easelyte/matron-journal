// A journal's federation identity (docs/protocol.md "Federation": journal
// identity): whether federation is on, the host that names this journal in
// every address (`name@host`), and the Ed25519 key it signs envelopes with.
//
// Off unless the operator says otherwise: MATRON_FEDERATION=on, an https
// MATRON_PUBLIC_URL (its host is the journal's name) and MATRON_TOKEN_KEY,
// because the private key is stored sealed under the token box in
// journal_settings and never in the clear. Any of the three missing, or a
// stored key that the token key cannot open, leaves federation off with one
// line in the log; the journal runs exactly as it does without it.
//
// The key is made the first time federation starts and is kept for good.
// There is no rotation: a journal whose key changes is a new journal to
// every peer, and its users exchange fresh invites.

import { createPrivateKey, createPublicKey } from 'node:crypto'
import { exportPublicKey, generateFederationKey, keyFingerprint, MAX_ENVELOPE_BYTES } from './federation-envelope.js'
import { json } from './http-body.js'
import { parsePublicUrl } from './mailer.js'

export const WELL_KNOWN_PATH = '/.well-known/matron-journal'

const KEY_SETTING = 'federation_key'
const KEY_CREATED_SETTING = 'federation_key_created_at'

// The switch and the name, from env (or the test seam). Never throws.
// {enabled:false, reason} when off; {enabled:true, baseUrl, host,
// allowJournals, denyJournals} when the operator turned it on with a usable
// public URL. The two lists (MATRON_FEDERATION_ALLOW_JOURNALS and
// MATRON_FEDERATION_DENY_JOURNALS, comma-separated hosts) say which other
// journals may federate with this one; see journalAllowed.
export function resolveFederationConfig({ federation, publicUrl, allowJournals = '', denyJournals = '' } = {}) {
  const raw = String(federation ?? '').trim().toLowerCase()
  if (raw === '' || raw === 'off' || raw === '0') return { enabled: false, reason: 'off' }
  if (raw !== 'on' && raw !== '1') return { enabled: false, reason: 'bad_switch' }
  const baseUrl = parsePublicUrl(publicUrl)
  if (!baseUrl) return { enabled: false, reason: 'no_public_url' }
  return {
    enabled: true, baseUrl, host: new URL(baseUrl).host.toLowerCase(),
    allowJournals: hostList(allowJournals), denyJournals: hostList(denyJournals),
  }
}

const hostList = (raw) => (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
  .map((s) => String(s).trim().toLowerCase()).filter(Boolean)

// May this journal federate with the journal at `host`? Never with itself,
// never with a denied host, and, when there is an allow list, only with a
// host on it. With no allow list, any journal a user exchanges an invite
// with may federate: the invite is the trust.
export function journalAllowed(federation, host) {
  if (!federation?.enabled || typeof host !== 'string') return false
  if (host.toLowerCase() === federation.host) return false
  return journalListed(federation, host)
}

// The operator's two lists alone: what the outbox checks before every
// attempt, so a journal denied after an op was queued gets nothing more.
export function journalListed(federation, host) {
  const h = String(host).toLowerCase()
  if (federation?.denyJournals?.includes(h)) return false
  if (federation?.allowJournals?.length && !federation.allowJournals.includes(h)) return false
  return true
}

const readSetting = (db, key) => db.prepare('SELECT value FROM journal_settings WHERE key=?').get(key)?.value ?? null

// The stored key, made on first call. Throws 'no_token_key' when the box has
// no key (the private key is never stored unsealed) and 'key_unreadable'
// when a stored key does not open under this token key.
export function ensureFederationKey(db, tokenBox, { now = Date.now } = {}) {
  if (!tokenBox?.enabled) throw new Error('no_token_key')
  let sealed = readSetting(db, KEY_SETTING)
  if (sealed === null) {
    const { privateKey } = generateFederationKey()
    const pem = privateKey.export({ format: 'pem', type: 'pkcs8' })
    // INSERT OR IGNORE: two processes on one database both starting for the
    // first time keep whichever key was written first.
    db.transaction(() => {
      db.prepare('INSERT OR IGNORE INTO journal_settings(key, value) VALUES(?, ?)').run(KEY_SETTING, tokenBox.seal(pem))
      db.prepare('INSERT OR IGNORE INTO journal_settings(key, value) VALUES(?, ?)').run(KEY_CREATED_SETTING, String(now()))
    })()
    sealed = readSetting(db, KEY_SETTING)
  }
  let privateKey
  try { privateKey = createPrivateKey(tokenBox.open(sealed)) } catch { throw new Error('key_unreadable') }
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('key_unreadable')
  const publicKey = createPublicKey(privateKey)
  const pub = exportPublicKey(publicKey)
  return { privateKey, publicKey, pub, fingerprint: keyFingerprint(pub), createdAt: Number(readSetting(db, KEY_CREATED_SETTING)) || null }
}

// The public half without opening the private key: what `matron-admin
// federation status` shows. null when no key has been made yet.
export function storedFederationKeyInfo(db, tokenBox) {
  const sealed = readSetting(db, KEY_SETTING)
  if (sealed === null) return null
  try {
    const pub = exportPublicKey(createPublicKey(createPrivateKey(tokenBox.open(sealed))))
    return { readable: true, pub, fingerprint: keyFingerprint(pub), createdAt: Number(readSetting(db, KEY_CREATED_SETTING)) || null }
  } catch {
    return { readable: false, createdAt: Number(readSetting(db, KEY_CREATED_SETTING)) || null }
  }
}

const OFF_REASONS = {
  bad_switch: 'MATRON_FEDERATION must be on or off',
  no_public_url: 'it needs an https MATRON_PUBLIC_URL',
  no_token_key: 'it needs MATRON_TOKEN_KEY to keep its key sealed',
  key_unreadable: 'the stored federation key does not open under this MATRON_TOKEN_KEY',
}

// Everything the server needs at boot: the config plus the key, or off with
// the reason logged once. {enabled:false} | {enabled:true, host, baseUrl,
// key}.
export function loadFederation(db, tokenBox, { federation, publicUrl, allowJournals, denyJournals, log = console, now } = {}) {
  const config = resolveFederationConfig({ federation, publicUrl, allowJournals, denyJournals })
  if (!config.enabled) {
    if (config.reason !== 'off') log.error(`federation: ${OFF_REASONS[config.reason]} — it is off`)
    return { enabled: false }
  }
  let key
  try { key = ensureFederationKey(db, tokenBox, { now }) } catch (err) {
    log.error(`federation: ${OFF_REASONS[err.message] ?? err.message} — it is off`)
    return { enabled: false }
  }
  log.log(`federation: on as ${config.host}, key ${key.fingerprint}`)
  return { ...config, key }
}

// The well-known identity document: public, cacheable, no user data. 404
// while federation is off, so a journal that never turned it on asserts
// nothing.
export function wellKnownDocument(federation) {
  return {
    v: 1,
    journal: federation.host,
    base_url: federation.baseUrl,
    key: { alg: 'ed25519', pub: federation.key.pub, id: federation.key.fingerprint },
    federation: { max_envelope: MAX_ENVELOPE_BYTES },
  }
}

export function makeFederationWellKnown(federation) {
  const body = federation?.enabled ? JSON.stringify(wellKnownDocument(federation)) : null
  return function handleFederationWellKnown(req, res, url) {
    if (url.pathname !== WELL_KNOWN_PATH) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (body === null) { json(res, 404, { error: 'not_found' }); return true }
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'access-control-allow-origin': '*',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }
}
