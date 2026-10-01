// The `routine` marker event (spec 2026-10-01 coordinator routines): one
// per create / update / delete / fire, appended into the user's Coordinator
// conversation so the apps refetch GET /routines live. Nothing when no
// Coordinator is set. Not a MESSAGE_TYPE (no unread, no snippet), not an
// AGENT_PUBLISH_TYPES member, never pushes, never wakes. The row's own
// write has already committed: a failing marker is logged and swallowed.
import { appendAndBroadcast } from './journal.js'
import { getCoordinatorConvoId } from './coordinator.js'

export const ROUTINE_EVENT_TYPE = 'routine'

export function emitRoutineMarker({ db, hub }, userId, { routine, action, sender, by = undefined, created = undefined, outcome = undefined }) {
  const convoId = getCoordinatorConvoId(db, userId)
  if (!convoId) return false
  const payload = { routine_id: routine.id, name: routine.name, action }
  if (by !== undefined) payload.by = by
  if (created !== undefined) payload.created = created
  if (outcome !== undefined) payload.outcome = outcome
  if (action === 'fired') payload.next_at = routine.next_at ?? null
  try {
    appendAndBroadcast(db, hub, { userId, convoId, sender, type: ROUTINE_EVENT_TYPE, payload })
    return true
  } catch (err) {
    console.error('routines: marker append failed (the write already stands)', err)
    return false
  }
}
