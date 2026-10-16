// The one cross-user read rule (spec 2026-09-23 tracker web/teams,
// "Visibility rule"): a viewer may read another user's conversation — and
// so the items, missions, milestones and prose excerpts hanging off it —
// when the conversation has a repo whose `host/org` scope both the viewer
// and the owner are verified members of (an `ok` GitHub link each), and
// the conversation's agent device is known, belongs to the conversation's
// owner (devices.id is a reusable rowid: a revoked id later handed to
// another user's public box must confer nothing), and is not private — a revoked
// device fails closed. One SQL fragment, one function; every widened route
// uses these and nothing else, the way privacy.js is the only copy of the
// private-device sieve.
//
// The fragment binds the viewer as the NAMED parameter @viewer, so a caller
// can splice it into a larger statement without counting positional
// placeholders. It expresses the ORG rule only: callers that also want the
// owner to pass add `<alias>.owner_user_id = @viewer OR (...)`.
export const sharedConvoSql = (c) => `(
  ${c}.repo_scope IS NOT NULL
  AND ${c}.owner_user_id <> @viewer
  AND EXISTS (SELECT 1 FROM github_orgs gv
              JOIN github_accounts av ON av.user_id = gv.user_id AND av.state = 'ok'
              WHERE gv.user_id = @viewer AND gv.scope = ${c}.repo_scope)
  AND EXISTS (SELECT 1 FROM github_orgs go
              JOIN github_accounts ao ON ao.user_id = go.user_id AND ao.state = 'ok'
              WHERE go.user_id = ${c}.owner_user_id AND go.scope = ${c}.repo_scope)
  AND (${c}.agent_device_id IS NULL
       OR EXISTS (SELECT 1 FROM devices d WHERE d.id = ${c}.agent_device_id
                  AND d.user_id = ${c}.owner_user_id AND d.private = 0))
)`

// The grant rule (spec 2026-10-02 matron-to-matron sharing, "Grants"): the
// second way across the user boundary, alongside the org rule above. A
// viewer may read a MISSION when its owner holds an active grant on it for
// a contact that is the viewer, and the two contact rows — the owner's and
// the viewer's own — are both active. Either side ending the contact, or
// either side revoking the grant, closes it at once: nothing is cached.
//
// It is a mission rule, not a conversation rule. A grant shares the tracker
// record (title, body, status, milestones as text, items, comments and
// their attachments) and never a transcript (spec decision 6), so
// canReadConvo is deliberately NOT widened: /convo/:id/messages and the
// per-conversation milestone list stay closed to a grantee. What a grantee
// sees of a granted mission is built in missions.js (grantedMissionDetail)
// and items.js (getGrantedItem), which apply the private-device sieve.
//
// Same named @viewer parameter as sharedConvoSql. `m` is the missions alias.
// Same-journal contacts only (peer_journal IS NULL) until federation.
export const grantedMissionSql = (m) => `EXISTS (
  SELECT 1 FROM grants g
  JOIN contacts oc ON oc.id = g.contact_id AND oc.user_id = g.owner_user_id
    AND oc.state = 'active' AND oc.peer_journal IS NULL
  JOIN contacts vc ON vc.user_id = oc.peer_user_id AND vc.peer_user_id = oc.user_id
    AND vc.state = 'active' AND vc.peer_journal IS NULL
  WHERE g.subject_kind = 'mission' AND g.subject_id = ${m}.id AND g.owner_user_id = ${m}.user_id
    AND g.state = 'active' AND oc.peer_user_id = @viewer AND ${m}.user_id <> @viewer
)`

// The level a viewer holds on a mission: 'owner' for its user, the grant's
// level for a grantee, null for everyone else.
export function missionAccess(db, viewerUserId, missionId) {
  const row = db.prepare(`SELECT m.user_id = @viewer AS own,
      (SELECT g.level FROM grants g
        JOIN contacts oc ON oc.id = g.contact_id AND oc.user_id = g.owner_user_id AND oc.state = 'active' AND oc.peer_journal IS NULL
        JOIN contacts vc ON vc.user_id = oc.peer_user_id AND vc.peer_user_id = oc.user_id AND vc.state = 'active' AND vc.peer_journal IS NULL
        WHERE g.subject_kind = 'mission' AND g.subject_id = m.id AND g.owner_user_id = m.user_id
          AND g.state = 'active' AND oc.peer_user_id = @viewer) AS level
    FROM missions m WHERE m.id = @id`).get({ viewer: viewerUserId, id: missionId })
  if (!row) return null
  return row.own ? 'owner' : (row.level ?? null)
}

export const canReadMission = (db, viewerUserId, missionId) => missionAccess(db, viewerUserId, missionId) != null

// Writes: today only the owner. `contribute` (phase 3) is the level that
// will pass here; a `read` grant never does.
export function canWriteMission(db, viewerUserId, missionId) {
  const level = missionAccess(db, viewerUserId, missionId)
  return level === 'owner'
}

export function canReadConvo(db, viewerUserId, convoId) {
  const row = db.prepare(`SELECT c.owner_user_id = @viewer AS own, ${sharedConvoSql('c')} AS shared
    FROM conversations c WHERE c.id = @id`).get({ viewer: viewerUserId, id: convoId })
  return !!row && (!!row.own || !!row.shared)
}

export function sharedOrgScopes(db, viewerUserId) {
  return db.prepare(`SELECT g.scope FROM github_orgs g JOIN github_accounts a ON a.user_id = g.user_id AND a.state='ok'
    WHERE g.user_id = ? ORDER BY g.scope`).all(viewerUserId).map((r) => r.scope)
}

// A colleague may fetch a blob only through a row they can already read:
// a prose event (text/diff — the excerpt types) in a shared conversation,
// an attachment on a non-consent item filed from one, or an attachment on
// an item of a mission granted to them. The referencing
// row's owner must also own the blob, so attaching someone else's blob id
// to your own item opens nothing. Anything else is the owner's alone.
export function canReadBlob(db, viewerUserId, blobId) {
  const row = db.prepare(`SELECT 1 AS ok WHERE EXISTS (
      SELECT 1 FROM events e
      JOIN blobs b ON b.id = e.blob_ref
      JOIN conversations c ON c.id = e.convo_id
      WHERE e.blob_ref = @id AND e.type IN ('text', 'diff') AND b.owner_user_id = e.user_id
        AND ${sharedConvoSql('c')})
    OR EXISTS (
      SELECT 1 FROM item_comments ic
      JOIN items i ON i.id = ic.item_id
      JOIN blobs b ON b.id = @id
      JOIN conversations c ON c.id = i.origin_convo_id
      WHERE ic.attachments LIKE '%"blob_ref":"' || @id || '"%' AND i.consent IS NULL AND b.owner_user_id = i.user_id
        AND ${sharedConvoSql('c')})
    OR EXISTS (
      -- A grantee: an attachment on an item of a granted mission, under the
      -- same sieve as GRANTED_ITEM in items.js (never a consent mirror,
      -- never an item filed from a private box, never a mission whose origin
      -- box is private).
      SELECT 1 FROM item_comments ic
      JOIN items i ON i.id = ic.item_id
      JOIN missions m ON m.id = i.mission_id
      JOIN blobs b ON b.id = @id
      WHERE ic.attachments LIKE '%"blob_ref":"' || @id || '"%' AND i.consent IS NULL AND b.owner_user_id = i.user_id
        AND m.user_id = i.user_id
        AND NOT EXISTS (SELECT 1 FROM conversations pc JOIN private_devices pd ON pd.id = pc.agent_device_id
                        WHERE pc.id = i.origin_convo_id)
        AND NOT EXISTS (SELECT 1 FROM conversations mo JOIN private_devices md ON md.id = mo.agent_device_id
                        WHERE mo.id = m.origin_convo_id)
        AND ${grantedMissionSql('m')})`).get({ viewer: viewerUserId, id: blobId })
  return !!row
}
