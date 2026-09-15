import { spawn, spawnSync } from 'node:child_process'
import { realpathSync, statSync } from 'node:fs'
import path from 'node:path'
import { json } from './http-body.js'

const DEFAULT_BUILDER_TIMEOUT_MS = 5000
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

function parseBuilderOutput(stdout, groupBy) {
  const payload = JSON.parse(stdout)
  if (
    payload === null || typeof payload !== 'object' || Array.isArray(payload) ||
    payload.schema_version !== 1 || payload.group_by !== groupBy ||
    !['ok', 'empty', 'error'].includes(payload.status) || !Array.isArray(payload.groups)
  ) {
    throw new Error('invalid Work-view envelope')
  }
  return payload
}

export function resolveClaimLiveness(db, convoId) {
  try {
    const row = db.prepare('SELECT session_state FROM conversations WHERE id=?').get(convoId)
    if (!row) return 'stale'
    return SESSION_LIVENESS.get(row.session_state) ?? 'unknown'
  } catch {
    return 'unknown'
  }
}

function resolvePayloadLiveness(db, payload) {
  for (const group of payload.groups) {
    if (group === null || typeof group !== 'object' || !Array.isArray(group.loops)) {
      throw new Error('invalid Work-view group')
    }
    for (const item of group.loops) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error('invalid Work-view loop')
      }
      if (item.claim === null) continue
      if (item.claim === undefined || typeof item.claim !== 'object' || Array.isArray(item.claim)) {
        throw new Error('invalid Work-view claim')
      }
      item.claim.liveness = resolveClaimLiveness(db, item.claim.convo_id)
    }
  }
  return payload
}

function runBuilder(view, groupBy) {
  const args = ['-m', 'scripts.work_view_cli', '--group-by', groupBy]
  if (view.storePath) args.push('--store', view.storePath)

  return new Promise((resolve) => {
    let child
    try {
      child = view.spawnImpl('python3', args, {
        cwd: view.producerRoot,
        env: childEnv(view.env),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch {
      view.logger.error('work view: builder could not be spawned')
      resolve(builderError(groupBy, 'builder_failed'))
      return
    }

    let stdout = ''
    let settled = false
    const settle = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      if (settled) return
      child.kill('SIGKILL')
      view.logger.error('work view: builder exceeded its deadline and was killed')
      settle(builderError(groupBy, 'builder_timeout'))
    }, view.timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    // Always drain stderr so a noisy failed builder cannot block on a full pipe.
    // Its content is deliberately not logged: producer errors may contain paths
    // or data that do not belong in the journal log.
    child.stderr.resume()
    child.on('error', () => {
      view.logger.error('work view: builder process failed')
      settle(builderError(groupBy, 'builder_failed'))
    })
    child.on('close', (code) => {
      if (settled) return
      if (code !== 0) {
        view.logger.error(`work view: builder exited non-zero (${code})`)
        settle(builderError(groupBy, 'builder_failed'))
        return
      }
      try {
        settle(resolvePayloadLiveness(view.db, parseBuilderOutput(stdout, groupBy)))
      } catch {
        view.logger.error('work view: builder emitted an invalid envelope')
        settle(builderError(groupBy, 'builder_failed'))
      }
    })
  })
}

export function createWorkView({
  db,
  env = process.env,
  timeoutMs = DEFAULT_BUILDER_TIMEOUT_MS,
  logger = console,
  spawnImpl = spawn,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Work-view builder timeout must be a positive integer')
  }
  const ownerUserId = parseOwnerUserId(env.WORK_VIEW_OWNER_USER_ID)
  const producerRoot = resolveProducerRoot(env.WORK_VIEW_PRODUCER_ROOT, env, spawnSyncImpl)
  const storePath = typeof env.WORK_VIEW_STORE_PATH === 'string' && env.WORK_VIEW_STORE_PATH
    ? env.WORK_VIEW_STORE_PATH
    : null
  return { db, env, timeoutMs, logger, spawnImpl, ownerUserId, producerRoot, storePath }
}

export async function handleWorkRoute(view, req, res, url, who) {
  if (req.method !== 'GET' || url.pathname !== '/work') return false
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

  json(res, 200, await runBuilder(view, groupBy))
  return true
}
