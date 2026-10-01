// Pure DB state for projects (spec 2026-09-30 projects & mission links §4).
// No hub, no markers here — src/projects-http.js owns side effects. Same
// stance as missions.js: every recoverable failure is a tagged Error the
// HTTP layer maps to one status.
import { nextNum, newId } from './items.js'
import { listMissions, milestoneRow, ORIGIN_SIEVE, STATUS_FIELDS, statusPrivateSql } from './missions.js'

export const MERGE_HOPS_MAX = 16
const now = () => Date.now()

// "The privacy sieve works as for missions" (§4.1): a project born in a
// private-owned conversation, or created by a private device, is invisible
// to an ordinary agent — the origin sieve — and a status written from/by
// one reads as four nulls — the status sieve. Read-time, current flags.
const PROJECT_ORIGIN_SIEVE = `(
  NOT EXISTS (SELECT 1 FROM devices od WHERE od.id = p.origin_device_id AND od.private = 1)
  AND NOT EXISTS (SELECT 1 FROM conversations oc JOIN devices od ON od.id = oc.agent_device_id
                  WHERE oc.id = p.origin_convo_id AND od.private = 1)
)`
const PROJECT_STATUS_PRIVATE = statusPrivateSql('p')

const selectSql = (excludePrivateOwned) => `SELECT p.*,
    ${excludePrivateOwned ? PROJECT_STATUS_PRIVATE : '0'} AS status_hidden,
    (SELECT q.num FROM projects q WHERE q.id = p.merged_into) AS merged_into_num
  FROM projects p`

// idem_key and status_device_id are internal; status_hidden is the
// per-caller verdict. merged_into_num is computed ("Merged into #N").
export function projectRow(row) {
  if (!row) return null
  const { idem_key: _idemKey, status_device_id: _statusDeviceId, status_hidden: hidden, ...out } = row
  out.closed_over_open_missions = Number(out.closed_over_open_missions || 0)
  out.merged_into_num = out.merged_into_num ?? null
  if (Number(hidden || 0)) for (const k of STATUS_FIELDS) out[k] = null
  return out
}

export function getProject(db, userId, idOrNum, { excludePrivateOwned = false } = {}) {
  const sieve = excludePrivateOwned ? `AND ${PROJECT_ORIGIN_SIEVE}` : ''
  if (typeof idOrNum === 'string' && idOrNum.startsWith('pj_')) {
    return projectRow(db.prepare(`${selectSql(excludePrivateOwned)} WHERE p.id=? AND p.user_id=? ${sieve}`).get(idOrNum, userId))
  }
  const n = Number(String(idOrNum).replace(/^#/, ''))
  if (!Number.isInteger(n) || n < 1) return null
  return projectRow(db.prepare(`${selectSql(excludePrivateOwned)} WHERE p.num=? AND p.user_id=? ${sieve}`).get(n, userId))
}

// Reads (GET /projects/:id, /lookup) follow a merge to the project that
// survived it (§4.2 "redirect to the target"), through the caller's sieve
// at every hop. Writes never do — they address the row itself.
export function resolveProject(db, userId, idOrNum, opts = {}) {
  const first = getProject(db, userId, idOrNum, opts)
  if (!first) return null
  let project = first
  for (let hops = 0; project.merged_into && hops < MERGE_HOPS_MAX; hops++) {
    const next = getProject(db, userId, project.merged_into, opts)
    if (!next) return null
    project = next
  }
  return { project, mergedFrom: project.id === first.id ? null : { id: first.id, num: first.num } }
}

export function createProject(db, { userId, deviceId, createdBy, convoId = null, title, body = '', idemKey = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const replay = () => {
      const dup = idemKey && db.prepare('SELECT id FROM projects WHERE user_id=? AND idem_key=?').get(userId, idemKey)
      return dup ? { project: getProject(db, userId, dup.id, { excludePrivateOwned }), duplicate: true } : null
    }
    const early = replay()
    if (early) return early
    const id = newId('pj')
    const num = nextNum(db, userId)
    const ts = now()
    try {
      db.prepare(`INSERT INTO projects(id,user_id,num,state,title,body,origin_convo_id,origin_device_id,created_by,idem_key,created_at,updated_at)
        VALUES(?,?,?,'open',?,?,?,?,?,?,?,?)`).run(id, userId, num, title, body, convoId, deviceId, createdBy, idemKey, ts, ts)
    } catch (err) {
      if (idemKey && err.code === 'SQLITE_CONSTRAINT_UNIQUE') { const late = replay(); if (late) return late }
      throw err
    }
    return { project: getProject(db, userId, id, { excludePrivateOwned }), duplicate: false }
  })()
}

// Mirrors updateMission: statusWriter {by, convoId, deviceId} is required
// for a status string; the five status columns are written as one set.
export function updateProject(db, { userId, projectId, fields, statusWriter = null, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const cur = db.prepare('SELECT state FROM projects WHERE id=? AND user_id=?').get(projectId, userId)
    if (!cur) return null
    if (cur.state === 'closed') throw new Error('closed')
    const ts = now()
    const sets = []; const args = []
    if (fields.title !== undefined) { sets.push('title=?'); args.push(fields.title) }
    if (fields.body !== undefined) { sets.push('body=?'); args.push(fields.body) }
    if (fields.status !== undefined) {
      if (fields.status !== null && !statusWriter) throw new Error('status_writer_required')
      const w = fields.status === null ? { by: null, convoId: null, deviceId: null } : statusWriter
      sets.push('status=?', 'status_by=?', 'status_convo_id=?', 'status_device_id=?', 'status_updated_at=?')
      args.push(fields.status, w.by, w.convoId ?? null, w.deviceId ?? null, fields.status === null ? null : ts)
    }
    sets.push('updated_at=?'); args.push(ts)
    db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id=? AND user_id=?`).run(...args, projectId, userId)
    return getProject(db, userId, projectId, { excludePrivateOwned })
  })()
}

// §4.2: open missions block an agent (the Coordinator) — 409 open_missions,
// listed through the caller's sieve, while a hidden one still blocks. The
// user closes over them; the count is recorded and the missions stay open
// and filed.
export function closeProject(db, { userId, projectId, by, summary, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const p = db.prepare('SELECT id, state FROM projects WHERE id=? AND user_id=?').get(projectId, userId)
    if (!p) throw new Error('no_project')
    if (p.state === 'closed') throw new Error('closed')
    const open = db.prepare(`SELECT m.num, m.title, NOT ${ORIGIN_SIEVE} AS is_private
      FROM missions m WHERE m.project_id = ? AND m.user_id = ? AND m.state = 'open' ORDER BY m.num`).all(p.id, userId)
    if (by === 'agent' && open.length) {
      const e = new Error('open_missions')
      e.missions = open.filter((m) => !excludePrivateOwned || !m.is_private).map(({ num, title }) => ({ num, title }))
      throw e
    }
    const ts = now()
    db.prepare(`UPDATE projects SET state='closed', close_summary=?, closed_by=?, closed_over_open_missions=?, closed_at=?, updated_at=?
      WHERE id=?`).run(summary, by, open.length, ts, ts, p.id)
    return { project: getProject(db, userId, p.id, { excludePrivateOwned }) }
  })()
}

// §4.2 merge: every mission (any state) moves to `into`; the source closes
// with "Merged into #N" and records merged_into. Rows are read unsieved —
// the HTTP layer resolves both ends through the caller's sieve first. movedMissionIds lets the
// HTTP layer write one `updated` marker (project_changed) per mission.
export function mergeProject(db, { userId, projectId, intoId, by, excludePrivateOwned = false }) {
  return db.transaction(() => {
    const src = db.prepare('SELECT id, state FROM projects WHERE id=? AND user_id=?').get(projectId, userId)
    const dst = db.prepare('SELECT id, num, state FROM projects WHERE id=? AND user_id=?').get(intoId, userId)
    if (!src || !dst) throw new Error('no_project')
    if (src.id === dst.id) throw new Error('same_project')
    if (src.state === 'closed') throw new Error('closed')
    if (dst.state === 'closed') throw new Error('into_closed')
    const ts = now()
    const moved = db.prepare('SELECT id FROM missions WHERE project_id=? AND user_id=? ORDER BY num').all(src.id, userId).map((r) => r.id)
    db.prepare('UPDATE missions SET project_id=?, updated_at=? WHERE project_id=? AND user_id=?').run(dst.id, ts, src.id, userId)
    db.prepare(`UPDATE projects SET state='closed', close_summary=?, closed_by=?, closed_at=?, merged_into=?, updated_at=? WHERE id=?`)
      .run(`Merged into #${dst.num}`, by, ts, dst.id, ts, src.id)
    // Flatten (controller ruling): every project earlier merged into the
    // source now points straight at the survivor, so redirects stay one
    // hop and "Merged into #N" names the project that actually holds the work.
    // updated_at moves too, so an incremental reader sees the new pointer.
    db.prepare('UPDATE projects SET merged_into=?, updated_at=? WHERE merged_into=? AND user_id=?').run(dst.id, ts, src.id, userId)
    db.prepare('UPDATE projects SET updated_at=? WHERE id=?').run(ts, dst.id)
    return {
      project: getProject(db, userId, dst.id, { excludePrivateOwned }),
      merged: getProject(db, userId, src.id, { excludePrivateOwned }),
      movedMissionIds: moved,
    }
  })()
}

const emptyRollup = () => ({ missions: { running: 0, waiting: 0, idle: 0, quiet: 0, closed: 0 }, needs_you: 0, open_items: 0, lastMissionActivityAt: null })

// Rollups come from the caller's OWN sieved mission rows (listMissions), so
// a hidden mission never adds to a count, a needs-you total or the time.
export function rollupsByProject(missions) {
  const out = new Map()
  for (const m of missions) {
    if (!m.project_id) continue
    if (!out.has(m.project_id)) out.set(m.project_id, emptyRollup())
    const r = out.get(m.project_id)
    r.missions[m.activity] += 1
    r.needs_you += m.needs_you
    r.open_items += m.open_items
    r.lastMissionActivityAt = Math.max(r.lastMissionActivityAt ?? 0, m.last_activity_at)
  }
  return out
}

export function withRollup(project, rollup = emptyRollup()) {
  const { lastMissionActivityAt, ...rest } = rollup
  const last = Math.max(...[project.created_at, project.status_updated_at, lastMissionActivityAt].filter((v) => v != null))
  return { ...project, ...rest, last_activity_at: last }
}

export function projectWithRollup(db, userId, project, { excludePrivateOwned = false } = {}) {
  if (!project) return null
  return withRollup(project, rollupsByProject(listMissions(db, userId, { projectId: project.id, excludePrivateOwned })).get(project.id))
}

export function listProjects(db, userId, { state = null, excludePrivateOwned = false } = {}) {
  const where = ['p.user_id = ?']; const args = [userId]
  if (state) { where.push('p.state = ?'); args.push(state) }
  if (excludePrivateOwned) where.push(PROJECT_ORIGIN_SIEVE)
  const rows = db.prepare(`${selectSql(excludePrivateOwned)} WHERE ${where.join(' AND ')}`).all(...args).map(projectRow)
  const rollups = rollupsByProject(listMissions(db, userId, { filed: true, excludePrivateOwned }))
  return rows.map((p) => withRollup(p, rollups.get(p.id)))
    .sort((a, b) => (b.last_activity_at - a.last_activity_at) || (b.created_at - a.created_at))
}

// GET /projects/:id (§4.2). Every array goes through the caller's sieve:
// private-owned conversations (convoSieve) and private-origin missions
// (ORIGIN_SIEVE) are dropped from items, milestones and session counts.
export function projectDetail(db, userId, project, { excludePrivateOwned = false } = {}) {
  const missions = listMissions(db, userId, { projectId: project.id, excludePrivateOwned })
  const convoSieve = excludePrivateOwned ? 'AND NOT EXISTS (SELECT 1 FROM devices pd WHERE pd.id = c.agent_device_id AND pd.private = 1)' : ''
  const originSieve = excludePrivateOwned ? `AND ${ORIGIN_SIEVE}` : ''
  const needsYou = db.prepare(`SELECT i.id, i.num, i.kind, i.state, i.awaiting, i.title, i.origin_convo_id, i.updated_at,
      i.mission_id, m.num AS mission_num
    FROM items i JOIN missions m ON m.id = i.mission_id JOIN conversations c ON c.id = i.origin_convo_id
    WHERE m.project_id = ? AND m.user_id = ? AND i.state = 'open' AND i.awaiting = 'user' ${convoSieve} ${originSieve}
    ORDER BY i.updated_at DESC`).all(project.id, userId)
  const recent = db.prepare(`SELECT l.*, m.num AS mission_num
    FROM milestones l JOIN missions m ON m.id = l.mission_id JOIN conversations c ON c.id = l.convo_id
    WHERE m.project_id = ? AND m.user_id = ? ${convoSieve} ${originSieve}
    ORDER BY l.created_at DESC, l.seq DESC LIMIT 5`).all(project.id, userId).map(milestoneRow)
  const boxes = db.prepare(`SELECT bd.name AS box, COUNT(DISTINCT c.id) AS n
    FROM missions m
    JOIN mission_conversations l ON l.mission_id = m.id AND l.ended_at IS NULL
    JOIN conversations c ON c.id = l.convo_id AND c.parent_convo_id IS NULL
    JOIN devices bd ON bd.id = c.agent_device_id
    WHERE m.project_id = ? AND m.user_id = ? AND m.state = 'open' ${excludePrivateOwned ? 'AND bd.private = 0' : ''} ${originSieve}
    GROUP BY bd.name ORDER BY bd.name`).all(project.id, userId)
  return {
    project: withRollup(project, rollupsByProject(missions).get(project.id)),
    missions,
    needs_you: needsYou,
    recent_milestones: recent,
    sessions_by_box: Object.fromEntries(boxes.map((b) => [b.box, b.n])),
  }
}
