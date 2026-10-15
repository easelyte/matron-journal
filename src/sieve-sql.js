// Dependency-free SQL fragments (spec 2026-10-12 unified search §2). No imports — the same zero-dependency leaf
// pattern as src/visibility.js — so importing this file can never create a
// load-order cycle the way importing missions.js or items.js can
// (search-docs.js -> missions.js -> items.js -> db.js -> search-docs.js).
//
// This is the "this conversation is owned by a private device" shape that
// already exists, independently written, in missions.js (the milestone
// sieve in countsSql, and missionDetail's PRIVATE_CONVO) and items.js
// (listItems' excludePrivateOwned). Those are deliberately left
// untouched here — this export is for NEW call sites (search-docs.js) so
// the SQL is imported, not copied, going forward; it does not retrofit the
// existing ones.
export const privateConvoSql = (col) => `EXISTS (SELECT 1 FROM conversations pc JOIN private_devices pd ON pd.id = pc.agent_device_id
  WHERE pc.id = ${col})`
