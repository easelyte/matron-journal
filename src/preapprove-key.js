import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

// Shared key-file-path resolution — same shape as resolveMediaDir
// (src/media.js): an explicit override wins, otherwise
// `<dirname(dbPath)>/preapprove.key`. No env var, no operator provisioning
// (Bugbot hardening for /link/preapprove: "no new secret to provision" —
// the key is auto-minted, never configured).
export function resolvePreapproveKeyPath(dbPath, override) {
  return override || path.join(path.dirname(dbPath), 'preapprove.key')
}

// Called once at server boot (src/server.js). Unlike resolveMediaDir this
// DOES touch disk immediately: the key must exist and be readable before
// the first /link/preapprove request can be answered, and the admin CLI
// (a separate process) needs a stable file to read.
//
// Missing file: mint 64 hex chars (32 bytes) and write them with mode
// 0600, using an exclusive create (`wx`) so two processes racing to boot
// against the same DB directory (e.g. two test files sharing the default
// `:memory:` DB's fallback key path) can't corrupt each other's key — the
// loser simply reads back the winner's file instead of throwing.
//
// Existing file: contents are trusted as-is (never overwritten — a
// rotated key would invalidate anything mid-flight and there is no
// provisioning step to update it from), but its mode is re-enforced to
// 0600 on every boot, covering a pre-existing file left with looser
// permissions (e.g. created by hand, or a filesystem with a permissive
// umask).
export function ensurePreapproveKey(dbPath, override) {
  const keyPath = resolvePreapproveKeyPath(dbPath, override)
  try {
    const key = crypto.randomBytes(32).toString('hex')
    fs.writeFileSync(keyPath, key, { mode: 0o600, flag: 'wx' })
    return key
  } catch (e) {
    if (e.code !== 'EEXIST') throw e
  }
  fs.chmodSync(keyPath, 0o600)
  return fs.readFileSync(keyPath, 'utf8').trim()
}
