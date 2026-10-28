// HTTP surface of archived conversations (src/archive.js). Client tokens
// only, like /pins: archiving is the user's own view of their list. Every
// change is sent live to the user's open apps ({kind:'archive'}).
//
//   GET  /archive?since=ms        → {changes, at, auto_archive_days}
//   POST /archive                 {convo_ids: [...], archived: bool} → {changes}
//
// POST answers with no `at`: an app advances its `since` only from GET,
// hello_ok and live frames, which never skip a change it has not seen.
import { json, readBody } from './http-body.js'
import { badRequest } from './http-who.js'
import { CONVO_ID_MAX_CHARS } from './journal.js'
import { ARCHIVE_BATCH_MAX, archiveChanges, setArchived, sendArchiveFrame, getAutoArchiveDays } from './archive.js'

const isConvoId = (s) => typeof s === 'string' && !!s && s.length <= CONVO_ID_MAX_CHARS

export async function handleArchiveRoute(ctx, req, res, url, who) {
  if (url.pathname !== '/archive') return false
  const { db, hub } = ctx
  if (who.kind !== 'client') { json(res, 403, { error: 'forbidden' }); return true }

  if (req.method === 'GET') {
    let since = null
    if (url.searchParams.has('since')) {
      since = Number(url.searchParams.get('since'))
      if (!Number.isInteger(since) || since < 0) return badRequest(res)
    }
    json(res, 200, { ...archiveChanges(db, who.userId, since), auto_archive_days: getAutoArchiveDays(db, who.userId) })
    return true
  }
  if (req.method !== 'POST') return false
  const body = await readBody(req)
  if (!body || typeof body !== 'object' || Array.isArray(body)) return badRequest(res)
  const { convo_ids: ids, archived } = body
  if (typeof archived !== 'boolean' || !Array.isArray(ids) || !ids.length || ids.length > ARCHIVE_BATCH_MAX || !ids.every(isConvoId)) {
    return badRequest(res)
  }
  const now = Date.now()
  const changes = setArchived(db, who.userId, ids, archived, { now })
  sendArchiveFrame(hub, who.userId, changes, now)
  json(res, 200, { changes })
  return true
}
