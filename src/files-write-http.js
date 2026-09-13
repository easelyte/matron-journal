// HTTP surface of the File Explorer WRITE API (spec §5.2/§5.3, plan Phase 2).
// Mounted from src/http.js beside the read routes, below the auth gate, the
// same way src/items-http.js and src/missions-http.js carry their own routes.
//
// Everything here funnels through ONE wrapper (`audited`) rather than five
// hand-rolled handlers, because the properties that matter are properties of
// the funnel, not of any single endpoint:
//
//   * the kill switch — routes only exist when writes are enabled AND write
//     roots are pinned; otherwise the request falls through to http.js's 404,
//     so a dormant deploy is indistinguishable from one that never had the
//     feature (feature-off parity with Phase 1);
//   * client devices only — an agent never writes the operator's disk;
//   * write-ahead audit — the intent line is durable before the first
//     irreversible fs call, and a failed append REFUSES (507) rather than
//     mutating unlogged;
//   * dry-run — validate, audit, drain, and answer 200 {dry_run:true} without
//     touching the filesystem;
//   * idempotency — a single-flight reservation keyed by the caller's key AND
//     a fingerprint of the request, so two concurrent retries perform one
//     mutation and a reused key carrying a DIFFERENT request is rejected
//     instead of being served someone else's result;
//   * one denial mapping — every rejection is a FileLinkDenied reason run
//     through denialToStatus, so no endpoint invents its own status.
import crypto from 'node:crypto'
import path from 'node:path'
import {
  FileLinkDenied, contains, denialToStatus,
  validateWriteTarget, writeFileAtomic, mkdirGuarded, moveGuarded, trashGuarded,
} from './file-guard.js'
import { json, readBody } from './http-body.js'
import { idemKeyOf } from './http-who.js'

// Uploads stream to disk and are bounded here rather than by readBody (which
// caps JSON bodies at 1 MB); /files/write carries its content INSIDE a JSON
// body, so readBody's cap already bounds it well below this.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024
export const MAX_FILENAME_CHARS = 255
// Matches the audit module's own path bound. Checked HERE so an absurd path is
// a plain 400 rather than tripping the audit's length guard and surfacing as a
// misleading 507 "could not complete safely".
export const MAX_PATH_CHARS = 4096
export const TRASH_DIR_NAME = '.matron-trash'
// Long enough to cover a client retrying a dropped response, short enough that
// a key is reusable for a deliberate repeat soon after. Matches the
// peer-message idempotency window (AGENT_IDEM_TTL_MS).
export const IDEM_TTL_MS = 120_000
export const IDEM_MAX_ENTRIES = 512

const badRequest = (res) => { json(res, 400, { error: 'bad_request' }); return true }
// A path the server will consider at all: a string, absolute, and bounded.
const absolutePath = (value) =>
  typeof value === 'string' && path.isAbsolute(value) && value.length <= MAX_PATH_CHARS
const forbidden = (res) => { json(res, 403, { error: 'forbidden' }); return true }

// The client sends a full destination path; the server owns the final
// component regardless. Control characters and separators are stripped (a
// separator cannot survive basename anyway, but the intent is explicit), and
// the names that are not files at all are refused outright.
export function sanitizeBasename(raw) {
  const cleaned = path.basename(String(raw ?? ''))
    .replace(/[\u0000-\u001f\u007f/\\]/g, '_')
    .trim()
  if (!cleaned || cleaned === '.' || cleaned === '..') return null
  if (cleaned.length > MAX_FILENAME_CHARS) return null
  return cleaned
}

// Does this directory accept writes right now? Drives the UI's affordances —
// absent or false means a strictly read-only browser. Dry-run reports FALSE on
// purpose: the routes answer, but nothing they are asked to do will happen, and
// an affordance that silently no-ops is worse than no affordance.
export function listingIsWritable(ctx, realDir) {
  if (!ctx.fileEnableWrites || ctx.fileWritesDryRun || !ctx.fileWriteRoots) return false
  if (realDir.split(path.sep).filter(Boolean).includes(TRASH_DIR_NAME)) return false
  return ctx.fileWriteRoots.roots.some((root) => contains(root.realPath, realDir))
}

// In-memory, bounded, TTL'd. DOCUMENTED RESIDUAL (plan deferred-(e)): a restart
// drops the map, so a retry that crosses one can re-execute its write. That is
// acceptable while Idempotency-Key is optional and the rollout is dormant-first;
// a durable store is the follow-up if a double-write ever bites.
export function makeIdemStore({ ttlMs = IDEM_TTL_MS, max = IDEM_MAX_ENTRIES, now = Date.now } = {}) {
  const entries = new Map()
  const sweep = () => {
    const t = now()
    for (const [key, entry] of entries) if (entry.expiresAt <= t) entries.delete(key)
  }
  return {
    size: () => entries.size,
    // Returns the in-flight or completed promise for `key`. The RESERVATION is
    // the promise itself, not the finished result — two concurrent retries
    // therefore share one execution instead of racing two mutations.
    run(key, fingerprint, factory) {
      sweep()
      const existing = entries.get(key)
      if (existing) {
        if (existing.fingerprint !== fingerprint) throw new FileLinkDenied('idem-key-conflict')
        return existing.promise
      }
      while (entries.size >= max) entries.delete(entries.keys().next().value)
      const promise = Promise.resolve().then(factory)
      const entry = { fingerprint, promise, expiresAt: now() + ttlMs }
      entries.set(key, entry)
      promise.then(
        () => { entry.expiresAt = now() + ttlMs },
        // A failed attempt is not a result worth replaying: drop the key so the
        // caller can genuinely retry rather than be handed the same failure.
        () => { if (entries.get(key) === entry) entries.delete(key) },
      )
      return promise
    },
  }
}

function fingerprintOf(req, url, payload) {
  return crypto.createHash('sha256')
    .update(`${req.method}\n${url.pathname}\n${JSON.stringify(payload)}`)
    .digest('hex')
}

// Bounded drain so a keep-alive socket is not left with unread body bytes to
// desync the next request's parse (the same hazard readBody's 413 path guards).
// Returns false when the body outran the bound — the caller then closes the
// connection instead, which is always safe.
async function drainBody(req, limit) {
  if (req.readableEnded || req.complete) return true
  let seen = 0
  try {
    for await (const chunk of req) {
      seen += chunk.length
      if (seen > limit) return false
    }
  } catch {
    return false
  }
  return true
}

// Every reply from a body-bearing route goes through here: if the body was not
// consumed to the end, the socket cannot be reused safely.
function answer(req, res, outcome, { bodyBearing = false } = {}) {
  if ((outcome.close || (bodyBearing && !(req.readableEnded || req.complete)))) {
    res.setHeader('Connection', 'close')
  }
  json(res, outcome.status, outcome.body)
  return true
}

// The funnel. `intent` is what the audit log will say we were ASKED to do;
// `run` performs the mutation and returns {status, body, audit?}.
//
// It RETURNS the outcome rather than writing it, because an idempotent replay
// shares one execution across two requests: the work runs once, but each
// request has to answer on its OWN socket. A funnel that wrote the response
// would leave the second caller hanging forever.
async function audited(ctx, who, intent, run) {
  const base = { ts: Date.now(), deviceId: who.deviceId, op: intent.op, path: intent.path }
  if (intent.to !== undefined) base.to = intent.to
  if (intent.bytes !== undefined) base.bytes = intent.bytes

  // WRITE-AHEAD GATE. Ordered with the containment/sensitivity/confirm checks,
  // before anything irreversible: if the intent cannot be recorded durably,
  // the operation does not happen at all.
  try {
    ctx.audit({ ...base, result: 'attempt' })
  } catch (err) {
    console.error('file writes: refusing — the audit intent line could not be written', err)
    return { status: denialToStatus('audit-fail-closed'), body: { error: 'denied' } }
  }

  // The outcome line is best-effort BY DESIGN: the intent line is already
  // durable, so a failure here still leaves a record of the attempt, and
  // rejecting a completed mutation would be the lie Codex F4 is about.
  const record = (result, extra) => {
    try {
      ctx.audit({ ...base, ...extra, result })
    } catch (err) {
      console.error(`file writes: the ${result} audit line could not be written (the intent line stands)`, err)
    }
  }

  try {
    const outcome = await run()
    record('ok', outcome.audit || {})
    return { status: outcome.status, body: outcome.body, close: outcome.close === true }
  } catch (err) {
    if (err instanceof FileLinkDenied) {
      record('denied', { reason: err.reason })
      return { status: denialToStatus(err.reason), body: { error: 'denied' } }
    }
    record('error', { reason: String(err?.code || 'error').slice(0, 64) })
    throw err
  }
}

// Runs `work` under the caller's Idempotency-Key when one was supplied.
// Without a key there is nothing to deduplicate and the work runs directly.
// Returns null when the header is present but unusable (the caller answers 400):
// silently ignoring it would leave a client believing a retry was deduped.
function withIdempotency(ctx, req, who, url, payload, work) {
  const key = idemKeyOf(req, who)
  if (key === undefined) return null
  if (key === null) return work()
  try {
    return ctx.idem.run(key, fingerprintOf(req, url, payload), work)
  } catch (err) {
    return Promise.reject(err)
  }
}

// Shared tail for every route: resolve the (possibly deduplicated) work and map
// a denial thrown OUTSIDE the audited funnel — today only an idempotency-key
// conflict, which is a request-level refusal with nothing to audit.
async function settle(req, res, pending, opts) {
  if (pending === null) return badRequest(res)
  let outcome
  try {
    outcome = await pending
  } catch (err) {
    if (!(err instanceof FileLinkDenied)) throw err
    outcome = { status: denialToStatus(err.reason), body: { error: 'denied' } }
  }
  return answer(req, res, outcome, opts)
}

export async function handleFilesWriteRoute(ctx, req, res, url, who) {
  // Kill switch + fail-closed roots + fail-closed audit: the routes do not
  // exist, so an attempt falls through to http.js's final 404 (feature-off
  // parity with Phase 1).
  if (!ctx.fileEnableWrites || !ctx.fileWriteRoots || !ctx.audit) return false

  const is = (method, pathname) => req.method === method && url.pathname === pathname
  const matched = is('POST', '/files/upload') || is('POST', '/files/mkdir')
    || is('POST', '/files/move') || is('POST', '/files/write')
    || is('DELETE', '/files')
  if (!matched) return false
  // Operator devices browse and write; agents do not touch the operator's disk.
  if (who.kind !== 'client') return forbidden(res)

  const { fileWriteRoots: writeRoots, fileWritesDryRun: dryRun } = ctx
  const uploadMax = ctx.fileWriteMaxBytes ?? MAX_UPLOAD_BYTES
  const opts = { bodyBearing: req.method !== 'DELETE' }

  // --- T-2.1: POST /files/upload?path=<abs-target-file> ---------------------
  if (is('POST', '/files/upload')) {
    const requested = url.searchParams.get('path')
    if (!absolutePath(requested)) return badRequest(res)
    const overwrite = url.searchParams.get('overwrite') === '1'
    const name = sanitizeBasename(requested)
    if (!name) return badRequest(res)
    const target = path.join(path.dirname(requested), name)

    const run = () => audited(ctx, who, { op: 'upload', path: target }, async () => {
      if (dryRun) {
        // Validate exactly as the real path would, then drain rather than
        // mutate. An early 200 over an unread body desyncs the socket.
        const canonical = validateWriteTarget(target, { writeRoots })
        const drained = await drainBody(req, uploadMax)
        return { status: 200, body: { path: canonical, dry_run: true }, close: !drained }
      }
      // The target is validated INSIDE writeFileAtomic before it opens its
      // temp file, so a denied destination never lands a single byte on disk;
      // the temp file is a sibling of the destination, so the commit is a
      // same-directory rename that cannot hit EXDEV.
      let bytes = 0
      async function* counted() {
        for await (const chunk of req) { bytes += chunk.length; yield chunk }
      }
      const canonical = await writeFileAtomic(target, counted(), {
        writeRoots, maxBytes: uploadMax, overwrite,
      })
      return { status: 200, body: { path: canonical, bytes }, audit: { path: canonical, bytes } }
    })

    return settle(req, res, withIdempotency(ctx, req, who, url, {
      target, overwrite, length: req.headers['content-length'] ?? null,
    }, run), opts)
  }

  // --- T-2.2: POST /files/mkdir {path} -------------------------------------
  if (is('POST', '/files/mkdir')) {
    const body = await readBody(req)
    const target = body.path
    if (!absolutePath(target)) return badRequest(res)

    const run = () => audited(ctx, who, { op: 'mkdir', path: target }, async () => {
      if (dryRun) return { status: 200, body: { path: validateWriteTarget(target, { writeRoots }), dry_run: true } }
      // mkdir-p, and an existing directory is the state the caller asked for:
      // idempotent 200, not a conflict.
      const canonical = await mkdirGuarded(target, { writeRoots })
      return { status: 200, body: { path: canonical }, audit: { path: canonical } }
    })

    return settle(req, res, withIdempotency(ctx, req, who, url, { target }, run), opts)
  }

  // --- T-2.3: POST /files/move {from,to} -----------------------------------
  if (is('POST', '/files/move')) {
    const body = await readBody(req)
    const { from, to } = body
    if (!absolutePath(from) || !absolutePath(to)) return badRequest(res)

    const run = () => audited(ctx, who, { op: 'move', path: from, to }, async () => {
      if (dryRun) {
        return {
          status: 200,
          body: {
            from: validateWriteTarget(from, { writeRoots }),
            to: validateWriteTarget(to, { writeRoots }),
            dry_run: true,
          },
        }
      }
      const moved = await moveGuarded(from, to, { writeRoots })
      return { status: 200, body: moved, audit: { path: moved.from, to: moved.to } }
    })

    return settle(req, res, withIdempotency(ctx, req, who, url, { from, to }, run), opts)
  }

  // --- T-2.4: POST /files/write {path, content, overwrite?} ----------------
  if (is('POST', '/files/write')) {
    const body = await readBody(req)
    const target = body.path
    if (!absolutePath(target)) return badRequest(res)
    if (typeof body.content !== 'string') return badRequest(res)
    if (body.overwrite !== undefined && typeof body.overwrite !== 'boolean') return badRequest(res)
    const content = Buffer.from(body.content, 'utf8')
    const overwrite = body.overwrite === true

    const run = () => audited(ctx, who, { op: 'write', path: target, bytes: content.length }, async () => {
      if (dryRun) {
        return {
          status: 200,
          body: { path: validateWriteTarget(target, { writeRoots }), bytes: content.length, dry_run: true },
        }
      }
      // Replacing an existing file needs overwrite:true, and the guard copies
      // the previous content into .matron-trash/ (fsynced) before the
      // replacement lands — so even a direct API client cannot lose data.
      const canonical = await writeFileAtomic(target, content, { writeRoots, overwrite })
      return {
        status: 200,
        body: { path: canonical, bytes: content.length },
        audit: { path: canonical, bytes: content.length },
      }
    })

    return settle(req, res, withIdempotency(ctx, req, who, url, {
      target, overwrite, contentHash: crypto.createHash('sha256').update(content).digest('hex'),
    }, run), opts)
  }

  // --- T-2.5: DELETE /files?path=&recursive=0|1&confirm=1 ------------------
  const requested = url.searchParams.get('path')
  if (!absolutePath(requested)) return badRequest(res)
  const recursive = url.searchParams.get('recursive') === '1'
  const confirmed = url.searchParams.get('confirm') === '1'

  const run = () => audited(ctx, who, { op: 'delete', path: requested }, async () => {
    // Server-enforced explicit confirm (R102's spirit): destructive, so the
    // caller must say so. Checked inside the funnel so the refusal is audited
    // like every other denial.
    if (!confirmed) throw new FileLinkDenied('confirm-required')
    if (dryRun) return { status: 200, body: { path: validateWriteTarget(requested, { writeRoots }), dry_run: true } }
    // Never unlink: the entry moves into <write-root>/.matron-trash/ under a
    // collision-resistant name. Deleting what is already gone is the state the
    // caller asked for, so it answers 200 with trashed:null — no invented path.
    const result = await trashGuarded(requested, { writeRoots, recursive })
    return {
      status: 200,
      body: result,
      audit: { path: result.path, ...(result.trashed ? { to: result.trashed } : {}) },
    }
  })

  return settle(req, res, withIdempotency(ctx, req, who, url, { requested, recursive, confirmed }, run), opts)
}
