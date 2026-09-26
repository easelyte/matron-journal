// The two app-link files (spec 2026-09-23 tracker web/teams, "Static
// hosting" and "Why not universal links alone"): Apple's AASA and Android's
// assetlinks, each claiming /u/* for the installed app. Built once from env
// at boot; a journal with nothing configured claims nothing (404), so a
// self-hosted journal without app builds never asserts an association it
// cannot honour. Unauthenticated by design — the platforms fetch these
// anonymously.
import { json } from './http-body.js'

const APPLE_ID_RE = /^[A-Z0-9]{10}\.[A-Za-z0-9.-]+$/
const PACKAGE_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)+$/
const FINGERPRINT_RE = /^([0-9A-F]{2}:){31}[0-9A-F]{2}$/

export const parseList = (raw) => String(raw || '').split(',').map((s) => s.trim()).filter(Boolean)

export function makeWellKnown({ appleAppIds = [], androidPackage = null, androidCertSha256 = [] } = {}) {
  for (const id of appleAppIds) if (!APPLE_ID_RE.test(id)) throw new Error(`MATRON_APPLE_APP_IDS: ${JSON.stringify(id)} is not TEAMID.bundle.id`)
  const fingerprints = androidCertSha256.map((f) => f.toUpperCase())
  for (const f of fingerprints) if (!FINGERPRINT_RE.test(f)) throw new Error(`MATRON_ANDROID_CERT_SHA256: ${JSON.stringify(f)} is not a colon-separated SHA-256 fingerprint`)
  if (androidPackage && !PACKAGE_RE.test(androidPackage)) throw new Error(`MATRON_ANDROID_PACKAGE: ${JSON.stringify(androidPackage)} is not a package name`)
  if (androidPackage && !fingerprints.length) throw new Error('MATRON_ANDROID_CERT_SHA256 is required alongside MATRON_ANDROID_PACKAGE')
  if (fingerprints.length && !androidPackage) throw new Error('MATRON_ANDROID_PACKAGE is required alongside MATRON_ANDROID_CERT_SHA256')

  const aasa = appleAppIds.length
    ? JSON.stringify({ applinks: { details: [{ appIDs: appleAppIds, components: [{ '/': '/u/*', comment: 'Matron tracker links' }] }] } })
    : null
  const assetlinks = androidPackage
    ? JSON.stringify([{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: androidPackage, sha256_cert_fingerprints: fingerprints } }])
    : null
  const files = { '/.well-known/apple-app-site-association': aasa, '/.well-known/assetlinks.json': assetlinks }

  return function handleWellKnown(req, res, url) {
    if (!(url.pathname in files)) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    const body = files[url.pathname]
    if (body === null) { json(res, 404, { error: 'not_found' }); return true }
    res.writeHead(200, {
      'content-type': 'application/json',
      'content-length': String(Buffer.byteLength(body)),
      'cache-control': 'public, max-age=3600',
      'x-content-type-options': 'nosniff',
    })
    res.end(req.method === 'HEAD' ? undefined : body)
    return true
  }
}
