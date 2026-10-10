import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { json } from './http-body.js'
import { compileJsonSchema } from './json-schema.js'

const DEFAULT_BUILDER_TIMEOUT_MS = 5000
const DEFAULT_BUILDER_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENT_BUILDERS = 2
const DEFAULT_MAX_QUEUED_BUILDERS = 16
const DEFAULT_BUILDER_SETTLEMENT_TIMEOUT_MS = 1000
const STARTUP_PROBE_TIMEOUT_MS = 10000
const STARTUP_PROBE_MAX_OUTPUT_BYTES = 64 * 1024
const INCLUDE_DETAIL_FLAG = '--include-detail'
const INCLUDE_DETAIL_FLAG_PATTERN = /(^|\s)--include-detail(\s|$)/m
const GROUP_BY_VALUES = new Set(['repo', 'domain'])
const SESSION_LIVENESS = new Map([
  ['running', 'live'],
  ['waiting', 'live'],
  ['done', 'stale'],
  ['archived', 'stale'],
])
const BUILDER_ERROR_MESSAGES = {
  builder_failed: 'The Work-view builder failed.',
  builder_timeout: 'The Work-view builder timed out.',
}
const BUILDER_QUEUE_OVERLOADED = Symbol('builder_queue_overloaded')
const WORK_VIEW_SCHEMA = JSON.parse(readFileSync(new URL('./contracts/work-view.schema.json', import.meta.url), 'utf8'))
export const WORK_VIEW_REQUIRED_ENV = Object.freeze([
  'WORK_VIEW_OWNER_USER_ID',
  'WORK_VIEW_PRODUCER_ROOT',
])

function childEnv(env) {
  // The builder needs an executable search path and locale, not the journal's
  // credentials. Keep the subprocess boundary allowlisted so adding a secret
  // to the unit environment cannot silently disclose it to another program.
  const clean = {}
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TMPDIR']) {
    if (typeof env[name] === 'string') clean[name] = env[name]
  }
  return clean
}

// Shared with the File Explorer owner gate (src/http.js): one parser, so the
// two owner-scoped surfaces accept and reject exactly the same values.
export function parseOwnerUserId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) return null
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) ? value : null
}

function resolveProducerRoot(raw, env, spawnSyncImpl, logger) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const configured = raw.trim()
  const disable = (reason) => {
    logger.error(
      `work view: /work disabled because WORK_VIEW_PRODUCER_ROOT=${JSON.stringify(configured)} ${reason}. ` +
      'Under systemd, ProtectHome=yes or ProtectSystem=strict can hide a path that exists and is readable on disk; ' +
      'site the producer outside protected homes or add a narrowly scoped mount/read exception.'
    )
    return null
  }
  if (!path.isAbsolute(configured)) {
    return disable('is not an absolute directory containing scripts.work_view_cli')
  }

  let producerRoot
  try {
    producerRoot = realpathSync(configured)
    if (!statSync(producerRoot).isDirectory()) throw new Error('not a directory')
    const cliPath = realpathSync(path.join(producerRoot, 'scripts', 'work_view_cli.py'))
    const relativeCliPath = path.relative(producerRoot, cliPath)
    if (relativeCliPath.startsWith('..' + path.sep) || path.isAbsolute(relativeCliPath)) {
      throw new Error('CLI resolves outside producer root')
    }
  } catch {
    return disable('is not a visible directory containing scripts.work_view_cli')
  }

  let probe
  try {
    probe = spawnSyncImpl(
      'python3',
      ['-m', 'scripts.work_view_cli', '--help'],
      {
        cwd: producerRoot,
        env: childEnv(env),
        // stdout is read for feature detection (see includeDetail below); stderr stays closed.
        stdio: ['ignore', 'pipe', 'ignore'],
        encoding: 'utf8',
        maxBuffer: STARTUP_PROBE_MAX_OUTPUT_BYTES,
        timeout: STARTUP_PROBE_TIMEOUT_MS,
      }
    )
  } catch {
    return disable('could not be probed for scripts.work_view_cli')
  }
  if (probe.error || probe.status !== 0) {
    return disable('does not resolve scripts.work_view_cli')
  }
  // The optional loop detail fields (opened / next_action / owner) are requested only from a
  // producer that advertises the flag. An older producer rejects unknown arguments, so asking
  // unconditionally would turn every /work into builder_failed after a journal-only deploy.
  const help = typeof probe.stdout === 'string' ? probe.stdout : ''
  return { producerRoot, includeDetail: INCLUDE_DETAIL_FLAG_PATTERN.test(help) }
}

function builderError(groupBy, code) {
  return {
    schema_version: 1,
    status: 'error',
    group_by: groupBy,
    groups: [],
    error: { code, message: BUILDER_ERROR_MESSAGES[code] },
  }
}

function parseBuilderOutput(stdout) {
  return JSON.parse(stdout)
}

export function compileWorkViewValidator() {
  return compileJsonSchema(WORK_VIEW_SCHEMA)
}

export function resolveClaimLiveness(db, convoId, ownerUserId) {
  try {
    const row = db.prepare(
      'SELECT session_state FROM conversations WHERE id=? AND owner_user_id=?'
    ).get(convoId, ownerUserId)
    if (!row) return 'stale'
    return SESSION_LIVENESS.get(row.session_state) ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function resolvePayloadLiveness(db, payload, ownerUserId) {
  if (!Array.isArray(payload?.groups)) return payload
  for (const group of payload.groups) {
    if (!Array.isArray(group?.loops)) continue
    for (const item of group.loops) {
      if (item?.claim !== null && typeof item?.claim === 'object' && !Array.isArray(item.claim)) {
        item.claim.liveness = resolveClaimLiveness(db, item.claim.convo_id, ownerUserId)
      }
    }
  }
  return payload
}

function makeBuilderSemaphore(limit, maxQueued, queueTimeoutMs) {
  let active = 0
  const queued = []

  const remove = (waiter, result) => {
    const index = queued.indexOf(waiter)
    if (index === -1) return
    queued.splice(index, 1)
    clearTimeout(waiter.timer)
    waiter.signal?.removeEventListener('abort', waiter.abort)
    waiter.resolve(result)
  }

  const release = () => {
    active -= 1
    while (queued.length > 0) {
      const waiter = queued.shift()
      clearTimeout(waiter.timer)
      waiter.signal?.removeEventListener('abort', waiter.abort)
      if (waiter.signal?.aborted) {
        waiter.resolve(null)
        continue
      }
      active += 1
      waiter.resolve(release)
      return
    }
  }

  return (signal) => {
    if (signal?.aborted) return Promise.resolve(null)
    if (active < limit) {
      active += 1
      return Promise.resolve(release)
    }
    if (queued.length >= maxQueued) return Promise.resolve(BUILDER_QUEUE_OVERLOADED)
    return new Promise((resolve) => {
      const waiter = { resolve, signal, abort: null, timer: null }
      waiter.abort = () => remove(waiter, null)
      signal?.addEventListener('abort', waiter.abort, { once: true })
      queued.push(waiter)
      waiter.timer = setTimeout(() => remove(waiter, BUILDER_QUEUE_OVERLOADED), queueTimeoutMs)
    })
  }
}

function killBuilder(child) {
  if (process.platform !== 'win32' && Number.isInteger(child.pid)) {
    try {
      process.kill(-child.pid, 'SIGKILL')
      return
    } catch (err) {
      if (err?.code !== 'ESRCH') throw err
    }
  }
  try { child.kill('SIGKILL') } catch { /* close/error handlers finish the request */ }
}

// argparse's exit status for a usage error, e.g. an argument the producer does not know.
const ARGPARSE_USAGE_EXIT = 2

async function spawnBuilderWithDetailFallback(view, groupBy, signal) {
  const includeDetail = view.includeDetail
  const result = await spawnBuilder(view, groupBy, signal, includeDetail)
  if (!includeDetail || result?.usageError !== true) return result?.payload ?? result
  // The startup probe saw --include-detail, but the producer now rejects it: it was rolled back
  // (or replaced) in place while the journal kept running. Stop asking for the optional fields and
  // rebuild once without them, so the Work view keeps working instead of failing until restart.
  view.includeDetail = false
  view.logger.error('work view: producer no longer accepts --include-detail; continuing without loop detail fields')
  if (signal?.aborted) return null
  const retry = await spawnBuilder(view, groupBy, signal, false)
  return retry?.payload ?? retry
}

function spawnBuilder(view, groupBy, signal, includeDetail = false) {
  const args = ['-m', 'scripts.work_view_cli', '--group-by', groupBy]
  if (view.storePath) args.push('--store', view.storePath)
  if (includeDetail) args.push(INCLUDE_DETAIL_FLAG)

  return new Promise((resolve) => {
    let child
    try {
      child = view.spawnImpl('python3', args, {
        cwd: view.producerRoot,
        env: childEnv(view.env),
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch {
      view.logger.error('work view: builder could not be spawned')
      resolve(builderError(groupBy, 'builder_failed'))
      return
    }

    let stdout = ''
    let stdoutBytes = 0
    let forced = false
    let forcedPayload = null
    let settled = false
    let settlementTimer = null
    let onAbort = null
    const settle = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(settlementTimer)
      signal?.removeEventListener('abort', onAbort)
      resolve(payload)
    }
    const terminate = (payload, message) => {
      if (forced) return
      forced = true
      forcedPayload = payload
      clearTimeout(timer)
      child.stdout.removeListener('data', onStdout)
      stdout = ''
      if (message) view.logger.error(message)
      settlementTimer = setTimeout(() => {
        view.logger.error('work view: killed builder did not settle before the post-kill deadline')
        settle(forcedPayload)
      }, view.builderSettlementTimeoutMs)
      // A descendant in another process group can inherit these descriptors
      // and keep ChildProcess's close event pending after the builder dies.
      // Close our pipe ends now; the settlement timer remains the final guard.
      child.stdout.destroy()
      child.stderr.destroy()
      try { killBuilder(child) } catch {
        view.logger.error('work view: builder process group could not be killed')
      }
    }
    const timer = setTimeout(() => {
      terminate(
        builderError(groupBy, 'builder_timeout'),
        'work view: builder exceeded its deadline and was killed'
      )
    }, view.timeoutMs)

    child.stdout.setEncoding('utf8')
    const onStdout = (chunk) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8')
      if (stdoutBytes > view.maxOutputBytes) {
        terminate(
          builderError(groupBy, 'builder_failed'),
          'work view: builder exceeded its output limit and was killed'
        )
        return
      }
      stdout += chunk
    }
    child.stdout.on('data', onStdout)
    // Always drain stderr so a noisy failed builder cannot block on a full pipe.
    // Its content is deliberately not logged: producer errors may contain paths
    // or data that do not belong in the journal log.
    child.stderr.resume()
    child.on('error', () => terminate(
      builderError(groupBy, 'builder_failed'),
      'work view: builder process failed'
    ))
    child.on('close', (code) => {
      if (forced) {
        settle(forcedPayload)
        return
      }
      if (code !== 0) {
        if (includeDetail && code === ARGPARSE_USAGE_EXIT) {
          settle({ usageError: true, payload: builderError(groupBy, 'builder_failed') })
          return
        }
        view.logger.error(`work view: builder exited non-zero (${code})`)
        settle(builderError(groupBy, 'builder_failed'))
        return
      }
      try {
        const payload = resolvePayloadLiveness(
          view.db,
          parseBuilderOutput(stdout),
          view.ownerUserId
        )
        if (payload.group_by !== groupBy || !view.validatePayload(payload)) {
          throw new Error('invalid Work-view envelope')
        }
        settle(payload)
      } catch {
        view.logger.error('work view: builder emitted an invalid envelope')
        settle(builderError(groupBy, 'builder_failed'))
      }
    })
    onAbort = () => terminate(null, 'work view: client disconnected; builder was killed')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

async function runBuilder(view, groupBy, signal) {
  const release = await view.acquireBuilder(signal)
  if (release === null) return null
  if (release === BUILDER_QUEUE_OVERLOADED) return BUILDER_QUEUE_OVERLOADED
  try {
    if (signal?.aborted) return null
    return await spawnBuilderWithDetailFallback(view, groupBy, signal)
  } finally {
    // spawnBuilder has a post-kill settlement deadline, so capacity cannot be
    // retained forever by a descendant that inherited the builder's pipes.
    release()
  }
}

export function createWorkView({
  db,
  env = process.env,
  timeoutMs = DEFAULT_BUILDER_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_BUILDER_MAX_OUTPUT_BYTES,
  maxConcurrentBuilders = DEFAULT_MAX_CONCURRENT_BUILDERS,
  maxQueuedBuilders = DEFAULT_MAX_QUEUED_BUILDERS,
  builderQueueTimeoutMs = timeoutMs,
  builderSettlementTimeoutMs = DEFAULT_BUILDER_SETTLEMENT_TIMEOUT_MS,
  logger = console,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Work-view builder timeout must be a positive integer')
  }
  if (!Number.isInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error('Work-view builder output limit must be a positive integer')
  }
  if (!Number.isInteger(maxConcurrentBuilders) || maxConcurrentBuilders <= 0) {
    throw new Error('Work-view builder concurrency limit must be a positive integer')
  }
  if (!Number.isInteger(maxQueuedBuilders) || maxQueuedBuilders < 0) {
    throw new Error('Work-view builder queue limit must be a non-negative integer')
  }
  if (!Number.isInteger(builderQueueTimeoutMs) || builderQueueTimeoutMs <= 0) {
    throw new Error('Work-view builder queue timeout must be a positive integer')
  }
  if (!Number.isInteger(builderSettlementTimeoutMs) || builderSettlementTimeoutMs <= 0) {
    throw new Error('Work-view builder settlement timeout must be a positive integer')
  }
  const ownerUserId = parseOwnerUserId(env[WORK_VIEW_REQUIRED_ENV[0]])
  const producerRootConfigured = typeof env[WORK_VIEW_REQUIRED_ENV[1]] === 'string' &&
    env[WORK_VIEW_REQUIRED_ENV[1]].trim() !== ''
  const resolved = resolveProducerRoot(env[WORK_VIEW_REQUIRED_ENV[1]], env, spawnSyncImpl, logger)
  const producerRoot = resolved?.producerRoot ?? null
  const includeDetail = resolved?.includeDetail === true
  const storePath = typeof env.WORK_VIEW_STORE_PATH === 'string' && env.WORK_VIEW_STORE_PATH
    ? env.WORK_VIEW_STORE_PATH
    : null
  return {
    db, env, timeoutMs, maxOutputBytes, builderSettlementTimeoutMs, logger, spawnImpl,
    ownerUserId, producerRoot, producerRootConfigured, storePath, includeDetail,
    validatePayload: compileWorkViewValidator(),
    acquireBuilder: makeBuilderSemaphore(maxConcurrentBuilders, maxQueuedBuilders, builderQueueTimeoutMs),
  }
}

export async function handleWorkRoute(view, req, res, url, who) {
  if (url.pathname !== '/work') return false
  res.setHeader('Cache-Control', 'private, no-store')
  if (req.method !== 'GET') return false
  if (!who) { json(res, 401, { error: 'unauthenticated' }); return true }

  if (view.ownerUserId === null) {
    view.logger.error('work view: WORK_VIEW_OWNER_USER_ID is absent or is not a positive integer')
    json(res, 500, { error: 'internal' })
    return true
  }
  if (who.userId !== view.ownerUserId) {
    json(res, 403, { error: 'forbidden' })
    return true
  }
  if (view.producerRoot === null) {
    if (!view.producerRootConfigured) {
      view.logger.error('work view: WORK_VIEW_PRODUCER_ROOT is absent')
    }
    json(res, 500, { error: 'internal' })
    return true
  }

  const groupByValues = url.searchParams.getAll('group_by')
  const groupBy = groupByValues.length === 0 ? 'repo' : groupByValues[0]
  if (groupByValues.length > 1 || !GROUP_BY_VALUES.has(groupBy)) {
    json(res, 400, { error: 'bad_request' })
    return true
  }

  const abortController = new AbortController()
  const abort = () => abortController.abort()
  req.once('aborted', abort)
  res.once('close', abort)
  if (req.aborted || res.destroyed) abort()
  try {
    const payload = await runBuilder(view, groupBy, abortController.signal)
    if (payload === BUILDER_QUEUE_OVERLOADED) json(res, 503, { error: 'overloaded' })
    else if (payload !== null) json(res, 200, payload)
  } finally {
    req.removeListener('aborted', abort)
    res.removeListener('close', abort)
  }
  return true
}
