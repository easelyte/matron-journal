// Parses a numeric journal user ID from an env/config string. Used by the
// file viewer owner gate (src/files-read-http.js): anything that is not
// a positive safe integer in decimal form is null, and null fails closed.
export function parseOwnerUserId(raw) {
  if (typeof raw !== 'string' || !/^[1-9]\d*$/.test(raw.trim())) return null
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) ? value : null
}
