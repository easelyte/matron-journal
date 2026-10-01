// The 'mission' and 'milestone' marker events (spec: Marker events).
// Written only by src/missions-http.js; never publishable by an agent
// (not in AGENT_PUBLISH_TYPES). Not MESSAGE_TYPES: no unread/snippet
// column effect. push.js classify() returns null for both — they are
// navigation, not attention.
//
// `withTitle` is the privacy boundary (fix round 2, Critical): a marker
// appended into a conversation that is NOT private-owned, for a mission whose
// ORIGIN conversation IS, carries numbers only — no `title`, no
// `mission_title`. Both builders take the same flag so the two payload shapes
// cannot drift; the predicate itself is privacy.js's markerTitleAllowed, and
// the drop happens at write time so the stored event, the live broadcast and
// every later WS replay all agree (ws.js replays payloads verbatim).
export const MISSION_EVENT_TYPE = 'mission'
export const MILESTONE_EVENT_TYPE = 'milestone'
export const MISSION_ACTIONS = ['created', 'joined', 'updated', 'closed', 'left', 'current_changed']

// The milestone marker's own seq is the anchor the apps jump to; the
// payload carries enough to render the inline card without a fetch.
// The milestone's OWN title/body/kind always stay: the milestone was posted
// into this conversation by its author and is this conversation's own
// content. Only the mission it points at can be from behind the sieve.
export function milestoneMarkerPayload({ milestone, mission, by, withTitle = true }) {
  return {
    milestone_id: milestone.id, num: milestone.num, kind: milestone.kind,
    title: milestone.title, body: milestone.body ?? '',
    mission_id: mission.id, mission_num: mission.num,
    ...(withTitle ? { mission_title: mission.title } : {}),
    by,
  }
}

// Apps use this only as an invalidation signal plus a one-line notice.
// open_item_nums is present only on a user-forced close over open items.
// status_changed (spec 2026-09-28 missions dashboard §1) is present only on
// an `updated` whose PATCH carried `status` — a flag, never the text: the
// marker is replayed verbatim to every agent on the origin conversation,
// and the status may be one an ordinary agent must not read.
// by_convo_id is present only on a `closed` whose agent named the closing
// conversation — the audit line behind "closed by the Coordinator" (a
// closing conversation that is not on the mission is the Coordinator by
// construction; the apps compare it with the Coordinator setting).
// project_changed (spec 2026-09-30 §4.2) is present only on an `updated`
// that moved the mission into, out of or between projects — the apps' cue
// to refresh GET /projects.
export function missionMarkerPayload({ mission, action, by, openItemNums = null, withTitle = true, statusChanged = false, byConvoId = null, projectChanged = false }) {
  if (!MISSION_ACTIONS.includes(action)) throw new Error(`unknown mission action: ${action}`)
  const out = {
    mission_id: mission.id, num: mission.num,
    ...(withTitle ? { title: mission.title } : {}),
    action, by,
  }
  if (openItemNums && openItemNums.length) out.open_item_nums = openItemNums
  if (statusChanged) out.status_changed = true
  if (byConvoId) out.by_convo_id = byConvoId
  if (projectChanged) out.project_changed = true
  return out
}
