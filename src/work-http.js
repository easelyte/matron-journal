import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { json } from './http-body.js'
import { compileJsonSchema } from './json-schema.js'

const DEFAULT_BUILDER_TIMEOUT_MS = 5000
const DEFAULT_BUILDER_MAX_OUTPUT_BYTES = 1024 * 1024
const DEFAULT_MAX_CONCURRENT_BUILDERS = 2
const STARTUP_PROBE_TIMEOUT_MS = 10000
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

function parseOwnerUserId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) return null
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) ? value : null
}

function resolveProducerRoot(raw, env, spawnSyncImpl) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const configured = raw.trim()
  if (!path.isAbsolute(configured)) {
    throw new Error('WORK_VIEW_PRODUCER_ROOT must be an absolute directory containing scripts.work_view_cli')
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
    throw new Error(`WORK_VIEW_PRODUCER_ROOT does not contain scripts.work_view_cli: ${configured}`)
  }

  const probe = spawnSyncImpl(
    'python3',
    ['-m', 'scripts.work_view_cli', '--help'],
    {
      cwd: producerRoot,
      env: childEnv(env),
      stdio: 'ignore',
      timeout: STARTUP_PROBE_TIMEOUT_MS,
    }
  )
  if (probe.error || probe.status !== 0) {
    throw new Error(`WORK_VIEW_PRODUCER_ROOT does not resolve scripts.work_view_cli: ${configured}`)
  }
  return producerRoot
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

function makeBuilderSemaphore(limit) {
  let active = 0
  const queued = []

  const release = () => {
    active -= 1
    while (queued.length > 0) {
      const waiter = queued.shift()
      waiter.signal?.removeEventListener('abort', waiter.abort)
      if (waiter.signal?.aborted) continue
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
    return new Promise((resolve) => {
      const waiter = { resolve, signal, abort: null }
      waiter.abort = () => {
        const index = queued.indexOf(waiter)
        if (index === -1) return
        queued.splice(index, 1)
        signal.removeEventListener('abort', waiter.abort)
        resolve(null)
      }
      signal?.addEventListener('abort', waiter.abort, { once: true })
      queued.push(waiter)
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

function spawnBuilder(view, groupBy, signal) {
  const args = ['-m', 'scripts.work_view_cli', '--group-by', groupBy]
  if (view.storePath) args.push('--store', view.storePath)

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
    const terminate = (payload, message) => {
      if (forced) return
      forced = true
      forcedPayload = payload
      clearTimeout(timer)
      child.stdout.removeListener('data', onStdout)
      child.stdout.resume()
      stdout = ''
      if (message) view.logger.error(message)
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
    child.on('error', () => {
      if (!forced) {
        forced = true
        forcedPayload = builderError(groupBy, 'builder_failed')
        clearTimeout(timer)
        view.logger.error('work view: builder process failed')
      }
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      if (forced) {
        resolve(forcedPayload)
        return
      }
      if (code !== 0) {
        view.logger.error(`work view: builder exited non-zero (${code})`)
        resolve(builderError(groupBy, 'builder_failed'))
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
        resolve(payload)
      } catch {
        view.logger.error('work view: builder emitted an invalid envelope')
        resolve(builderError(groupBy, 'builder_failed'))
      }
    })
    const onAbort = () => terminate(null, 'work view: client disconnected; builder was killed')
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

async function runBuilder(view, groupBy, signal) {
  const release = await view.acquireBuilder(signal)
  if (release === null) return null
  try {
    if (signal?.aborted) return null
    return await spawnBuilder(view, groupBy, signal)
  } finally {
    // spawnBuilder resolves only from the child's close event, so capacity is
    // not released while a killed process (or one of its open pipes) remains.
    release()
  }
}

export function createWorkView({
  db,
  env = process.env,
  timeoutMs = DEFAULT_BUILDER_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_BUILDER_MAX_OUTPUT_BYTES,
  maxConcurrentBuilders = DEFAULT_MAX_CONCURRENT_BUILDERS,
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
  const ownerUserId = parseOwnerUserId(env[WORK_VIEW_REQUIRED_ENV[0]])
  const producerRoot = resolveProducerRoot(env[WORK_VIEW_REQUIRED_ENV[1]], env, spawnSyncImpl)
  const storePath = typeof env.WORK_VIEW_STORE_PATH === 'string' && env.WORK_VIEW_STORE_PATH
    ? env.WORK_VIEW_STORE_PATH
    : null
  return {
    db, env, timeoutMs, maxOutputBytes, logger, spawnImpl, ownerUserId, producerRoot, storePath,
    validatePayload: compileWorkViewValidator(),
    acquireBuilder: makeBuilderSemaphore(maxConcurrentBuilders),
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
    view.logger.error('work view: WORK_VIEW_PRODUCER_ROOT is absent')
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
    if (payload !== null) json(res, 200, payload)
  } finally {
    req.removeListener('aborted', abort)
    res.removeListener('close', abort)
  }
  return true
}
