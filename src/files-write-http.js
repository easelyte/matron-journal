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
//     instead of being served someone else's result. The reservation itself
//     lives in src/file-idem.js, durably: it has to outlive this process, or a
//     retry crossing a restart re-executes its move/delete/upload;
//   * one denial mapping — every rejection is a FileLinkDenied reason run
//     through denialToStatus, so no endpoint invents its own status.
import crypto from 'node:crypto'
import path from 'node:path'
import {
  FileLinkDenied, contains, denialToStatus,
  writeFileAtomic, mkdirGuarded, moveGuarded, trashGuarded,
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

function fingerprintOf(req, url, payload) {
  return crypto.createHash('sha256')
    .update(`${req.method}\n${url.pathname}\n${JSON.stringify(payload)}`)
    .digest('hex')
}

// Bounded consume-and-hash. Two jobs at once: it drains the body so a
// keep-alive socket is not left with unread bytes to desync the next request's
// parse (the hazard readBody's 413 path guards), and it produces the digest an
// idempotent upload REPLAY needs — a raw byte stream is the one part of a
// request the fingerprint cannot cover before the work runs, so the only honest
// way to know a replay is the same request is to read its bytes and compare.
// `complete:false` means the body outran the bound and the connection has to be
// closed rather than reused.
async function consumeBody(req, limit) {
  const digest = crypto.createHash('sha256')
  let seen = 0
  try {
    for await (const chunk of req) {
      seen += chunk.length
      if (seen > limit) return { complete: false, hash: null }
      digest.update(chunk)
    }
  } catch {
    return { complete: false, hash: null }
  }
  return { complete: true, hash: digest.digest('hex') }
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
    return {
      status: outcome.status,
      body: outcome.body,
      close: outcome.close === true,
      contentHash: outcome.contentHash,
    }
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
//
// `intent` is recorded WITH the reservation, and exists for exactly one case:
// a reservation that outlives the process executing it. The filesystem is then
// the only witness to whether the work happened, and it can only be questioned
// by something that knows what was attempted (see file-idem.js).
function withIdempotency(ctx, req, who, url, payload, work, intent) {
  const key = idemKeyOf(req, who)
  if (key === undefined) return null
  if (key === null) return work()
  try {
    return ctx.idem.run(key, fingerprintOf(req, url, payload), work, intent)
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

// Upload's own tail. The other four routes carry their whole request in a JSON
// body the fingerprint hashes, so an equal fingerprint really is an equal
// request. An upload's payload is a stream that cannot be hashed before the
// work runs, and Content-Length is neither present for chunked bodies nor
// distinguishing between two same-length payloads — fingerprinting it would
// serve the first upload's 200 to a caller whose bytes were silently dropped.
// So a REPLAY reads and hashes its own body and compares it with what the first
// execution actually wrote; a mismatch is the same conflict a mismatched
// fingerprint would have been.
async function settleUpload(ctx, req, res, who, url, payload, run, uploadMax, opts, intent) {
  const key = idemKeyOf(req, who)
  if (key === undefined) return badRequest(res)
  if (key === null) return settle(req, res, run(), opts)

  let reservation
  try {
    reservation = ctx.idem.reserve(key, fingerprintOf(req, url, payload), run, intent)
  } catch (err) {
    if (!(err instanceof FileLinkDenied)) throw err
    return answer(req, res, { status: denialToStatus(err.reason), body: { error: 'denied' } }, opts)
  }
  if (!reservation.replay) return settle(req, res, reservation.promise, opts)

  const replay = await consumeBody(req, uploadMax)
  let first
  try {
    first = await reservation.promise
  } catch (err) {
    if (!(err instanceof FileLinkDenied)) throw err
    first = { status: denialToStatus(err.reason), body: { error: 'denied' } }
  }
  // `contentHash` is absent when the first attempt never consumed a body (it
  // was denied during validation), and such a result does not depend on the
  // bytes — so it replays as-is.
  if (first.contentHash !== undefined) {
    if (!replay.complete) {
      return answer(req, res, { status: denialToStatus('too-large'), body: { error: 'denied' }, close: true }, opts)
    }
    if (first.contentHash !== replay.hash) {
      return answer(req, res, { status: denialToStatus('idem-key-conflict'), body: { error: 'denied' } }, opts)
    }
  }
  return answer(req, res, first, opts)
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
      // Dry-run goes through the SAME primitive with the same options and
      // stops at its irreversibility boundary — it drains and counts the body
      // (so the size cap is answered and the socket stays reusable) but opens
      // no file. A reduced validator here is how a rollout check ends up
      // approving what the live request rejects.
      // The target is validated INSIDE writeFileAtomic before it opens its
      // temp file, so a denied destination never lands a single byte on disk;
      // the temp file is a sibling of the destination, so the commit is a
      // same-directory rename that cannot hit EXDEV.
      let bytes = 0
      const digest = crypto.createHash('sha256')
      async function* counted() {
        for await (const chunk of req) { bytes += chunk.length; digest.update(chunk); yield chunk }
      }
      const canonical = await writeFileAtomic(target, counted(), {
        writeRoots, maxBytes: uploadMax, overwrite, dryRun,
      })
      if (dryRun) return { status: 200, body: { path: canonical, bytes, dry_run: true } }
      return {
        status: 200,
        body: { path: canonical, bytes },
        audit: { path: canonical, bytes },
        contentHash: digest.digest('hex'),
      }
    })

    return settleUpload(ctx, req, res, who, url, { target, overwrite }, run, uploadMax, opts,
      { op: 'upload', path: target })
  }

  // --- T-2.2: POST /files/mkdir {path} -------------------------------------
  if (is('POST', '/files/mkdir')) {
    const body = await readBody(req)
    const target = body.path
    if (!absolutePath(target)) return badRequest(res)

    const run = () => audited(ctx, who, { op: 'mkdir', path: target }, async () => {
      // mkdir-p, and an existing directory is the state the caller asked for:
      // idempotent 200, not a conflict.
      const canonical = await mkdirGuarded(target, { writeRoots, dryRun })
      if (dryRun) return { status: 200, body: { path: canonical, dry_run: true } }
      return { status: 200, body: { path: canonical }, audit: { path: canonical } }
    })

    return settle(req, res, withIdempotency(ctx, req, who, url, { target }, run,
      { op: 'mkdir', path: target }), opts)
  }

  // --- T-2.3: POST /files/move {from,to} -----------------------------------
  if (is('POST', '/files/move')) {
    const body = await readBody(req)
    const { from, to } = body
    if (!absolutePath(from) || !absolutePath(to)) return badRequest(res)

    const run = () => audited(ctx, who, { op: 'move', path: from, to }, async () => {
      const moved = await moveGuarded(from, to, { writeRoots, dryRun })
      if (dryRun) return { status: 200, body: { ...moved, dry_run: true } }
      return { status: 200, body: moved, audit: { path: moved.from, to: moved.to } }
    })

    return settle(req, res, withIdempotency(ctx, req, who, url, { from, to }, run,
      { op: 'move', path: from, to }), opts)
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
      // Replacing an existing file needs overwrite:true, and the guard copies
      // the previous content into .matron-trash/ (fsynced) before the
      // replacement lands — so even a direct API client cannot lose data.
      const canonical = await writeFileAtomic(target, content, { writeRoots, overwrite, dryRun })
      if (dryRun) return { status: 200, body: { path: canonical, bytes: content.length, dry_run: true } }
      return {
        status: 200,
        body: { path: canonical, bytes: content.length },
        audit: { path: canonical, bytes: content.length },
      }
    })

    return settle(req, res, withIdempotency(ctx, req, who, url, {
      target, overwrite, contentHash: crypto.createHash('sha256').update(content).digest('hex'),
    }, run, { op: 'write', path: target }), opts)
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
    // Never unlink: the entry moves into <write-root>/.matron-trash/ under a
    // collision-resistant name. Deleting what is already gone is the state the
    // caller asked for, so it answers 200 with trashed:null — no invented path.
    const result = await trashGuarded(requested, { writeRoots, recursive, dryRun })
    if (dryRun) return { status: 200, body: { path: result.path, dry_run: true } }
    return {
      status: 200,
      body: result,
      audit: { path: result.path, ...(result.trashed ? { to: result.trashed } : {}) },
    }
  })

  return settle(req, res, withIdempotency(ctx, req, who, url, { requested, recursive, confirmed }, run,
    { op: 'delete', path: requested }), opts)
}
