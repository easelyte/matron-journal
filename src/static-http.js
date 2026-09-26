// Static hosting of the tracker web app (spec 2026-09-23 tracker
// web/teams, "Static hosting"). Inert unless MATRON_WEB_DIR is set. Serves
// files under that directory read-only, and the directory's index.html for
// the app's client-side routes (/u/*, /app/*). Mounted before Bearer auth
// — a browser has no token when it loads the app — so it must never be a
// way to read anything but that directory: the resolved path is checked
// against the root, dot-segments (.git, .env, ..) never serve, and
// anything it does not own falls through to the API's own 401/404.
import fs from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}
export const FALLBACK_PREFIXES = ['/u/', '/app/']

export function resolveWebDir(raw) {
  if (!raw) return null
  const dir = path.resolve(raw)
  let st
  try { st = fs.statSync(dir) } catch { throw new Error(`MATRON_WEB_DIR ${raw} does not exist`) }
  if (!st.isDirectory()) throw new Error(`MATRON_WEB_DIR ${raw} is not a directory`)
  return dir
}

export function makeStaticHandler({ webDir }) {
  if (!webDir) return async () => false
  const index = path.join(webDir, 'index.html')

  async function send(req, res, file, { immutable }) {
    const st = await fs.promises.stat(file)
    const ext = path.extname(file).toLowerCase()
    const type = TYPES[ext] || 'application/octet-stream'
    const headers = {
      'content-type': type,
      'content-length': String(st.size),
      'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
      'x-content-type-options': 'nosniff',
    }
    if (ext === '.html') headers['x-frame-options'] = 'DENY'
    res.writeHead(200, headers)
    if (req.method === 'HEAD') { res.end(); return true }
    // pipeline (not .pipe()) so a client abort mid-body destroys the read
    // stream too — .pipe() alone leaves the source fd open forever when the
    // destination closes first, and this handler runs unauthenticated.
    await pipeline(fs.createReadStream(file), res).catch(() => {})
    return true
  }

  return async function handleStatic(req, res, url) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return false }
    if (pathname.includes('\0') || pathname.includes('\\')) return false
    if (pathname === '/') { res.writeHead(302, { location: '/app/' }); res.end(); return true }
    // No dot-segment ever serves: that covers `..`, `.git`, `.env`, and
    // leaves /.well-known to its own handler.
    if (pathname.split('/').some((seg) => seg.startsWith('.'))) return false
    const abs = path.resolve(webDir, '.' + pathname)
    if (abs !== webDir && !abs.startsWith(webDir + path.sep)) return false
    const isFallback = pathname === '/app' || FALLBACK_PREFIXES.some((p) => pathname.startsWith(p))
    // A tool resolving a link asks for JSON; that is the API's lookup route.
    if (isFallback && /application\/json/.test(req.headers.accept || '')) return false
    let st = null
    try { st = await fs.promises.stat(abs) } catch { /* not a file here */ }
    if (st && st.isFile()) return send(req, res, abs, { immutable: pathname.startsWith('/assets/') })
    if (isFallback) {
      try { await fs.promises.access(index) } catch { return false }
      return send(req, res, index, { immutable: false })
    }
    return false
  }
}
