// Server-side path-jail for the Matron File Explorer read API (spec:
// docs/superpowers/specs/2026-08-10-matron-file-explorer-design.md §5).
//
// Ported from the bridge's lib/file-link-guard.js + lib/show-file.js, kept
// behaviour-identical on the security-relevant primitives (contains,
// isSensitivePath, pinAllowedRoots(Sync), validateAndOpen, denialToStatus).
// The bridge and the journal are INDEPENDENT enforcement points for
// independent surfaces (bridge guards its show-file/viewer; the journal
// guards its file API) — not two sources of one datum. The ported guard test
// suite (test/file-guard.test.js) is copied alongside so the two copies
// cannot silently diverge on the security cases.
//
// Net-new here (the bridge only ever opens single files): listDirGuarded (the
// directory listing primitive), metaGuarded (a guarded stat that reads no
// bytes), and a broader extension->MIME map for content preview.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export const MAX_VIEW_BYTES = 5 * 1024 * 1024;
// /download-disposition serves whole artifacts (bundles, archives) rather than
// rendering — larger, but still bounded — budget.
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
// Max entries returned per listing before the response is marked truncated
// (no silent caps — the client is told the listing was cut).
export const MAX_LIST_ENTRIES = 2000;

// Basename patterns applied to EVERY path segment (a sensitively-named
// directory denies its contents). Bridge PR #54 set, hardened (review F2) to
// cover the credential/config dirs + files that live under a broad `/root`
// read-root — a compromised journal session must never be able to fetch e.g.
// /root/.codex/auth.json or /root/.config/**.
const SENSITIVE_BASENAME_PATTERNS = [
  // Credential / config directories (deny the dir segment => denies its tree).
  /^\.ssh$/i,
  /^\.aws$/i,
  /^\.gnupg$/i,
  /^\.kube$/i,
  /^\.docker$/i,
  /^\.codex$/i,
  /^\.config$/i,
  /^\.claude$/i,
  /^\.gcloud$/i,
  /^\.azure$/i,
  // Credential / secret files.
  /\.env(\..*)?$/i,
  /secrets?\.(json|ya?ml|toml|txt)$/i,
  /^secrets?$/i,
  /^credentials$/i,
  /credentials?\.(json|ya?ml|toml|txt)$/i,
  /^auth\.json$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /id_rsa|id_ed25519|id_ecdsa/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pgpass$/i,
  /^\.git-credentials$/i,
  /^\.claude\.json$/i,
  /token(s)?\.(json|txt)$/i,
  /service[-_]?account.*\.json$/i,
  /^\.htpasswd$/i,
  /^config\.json$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/\.aws\//i,
  /\/\.docker\//i,
  /\/\.kube\//i,
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
  /\/\.codex\//i,
  /\/\.config\//i,
  /\/\.claude\//i,
  /\/\.env(\.[^/]*)?\//i,
  /\/secrets?\//i,
  /\/credentials?\//i,
];

export function isSensitivePath(filePath) {
  const segments = String(filePath).split(path.sep).filter(Boolean);
  if (segments.some((seg) => SENSITIVE_BASENAME_PATTERNS.some((re) => re.test(seg)))) return true;
  if (SENSITIVE_PATH_PATTERNS.some((re) => re.test(filePath))) return true;
  return false;
}

// Path-boundary-safe containment: /a/b contains /a/b and /a/b/c, not /a/bc.
// The filesystem root contains everything (parent + sep would test '//').
export function contains(parent, child) {
  if (parent === path.sep) return true;
  return child === parent || child.startsWith(parent + path.sep);
}

export function checkFileLink(filePath, workdir) {
  if (!path.isAbsolute(String(filePath))) return { ok: false, reason: 'relative-path' };
  const resolved = path.resolve(filePath);
  if (isSensitivePath(resolved)) return { ok: false, reason: 'sensitive' };
  if (workdir && !contains(path.resolve(workdir), resolved)) {
    return { ok: false, reason: 'outside-workdir' };
  }
  return { ok: true };
}

export class FileLinkDenied extends Error {
  constructor(reason) {
    super(`file link denied: ${reason}`);
    this.name = 'FileLinkDenied';
    this.reason = reason;
  }
}

// Uniform denial->status so the denial reason never leaks which check tripped.
// Mirrors the bridge's lib/show-file.js:denialToStatus, plus 'not-a-dir'
// (listing a non-directory) which lands with the other 404 reasons.
// NAME_MAX on every filesystem we run on. A single component longer than this
// is ENAMETOOLONG at mkdir/open time — which, on a recursive mkdir, can happen
// AFTER earlier components were already created. Rejecting it up front keeps
// dry-run and live in agreement and keeps a client-controlled path from
// leaving half a directory tree behind (Codex R3-F2).
export const MAX_NAME_BYTES = 255;

export function denialToStatus(reason) {
  if (reason === 'sensitive'
      || reason === 'outside-scope'
      || reason === 'trash-protected'
      || reason === 'protected-path') return 403;
  // Phase-2 write conflicts. Each names a state the caller can resolve by
  // choosing differently (pick another name, pass overwrite/confirm, empty the
  // directory, retry a changed source) — a 409, never the 502 fallback, which
  // would read as "the server is broken" for an ordinary user-resolvable
  // conflict (plan T-2.0 / Claude B3 / Codex F6).
  if (reason === 'dest-exists'
      || reason === 'dir-not-empty'
      || reason === 'overwrite-conflict'
      || reason === 'cross-device-dir'
      || reason === 'confirm-required'
      || reason === 'source-changed'
      || reason === 'idem-key-conflict') return 409;
  if (reason === 'too-large') return 413;
  // A malformed request, not a policy refusal: the caller fixes it by sending
  // a shorter name, and no state on the server is in the way.
  if (reason === 'name-too-long') return 400;
  // Storage-side refusals: the request was well-formed and authorized, but the
  // server could not complete it SAFELY (no recoverable copy in the trash, no
  // durable audit record). 507 keeps them distinct from a 5xx bug.
  if (reason === 'trash-write-failed'
      || reason === 'audit-fail-closed'
      || reason === 'metadata-preserve-failed') return 507;
  // Every idempotency reservation is occupied by work that is still running.
  // Transient and retryable — 503, not a conflict and not a bug.
  if (reason === 'idem-store-full') return 503;
  // The reservation outlived the process executing it, and the filesystem
  // cannot prove the work never happened. Grouped with the 507s because it is
  // the same statement: well-formed, authorized, and NOT completed safely.
  // Deliberately not a 409 — a conflict invites "pick another name and retry",
  // and retrying is the one thing that must not happen while the first
  // outcome is unknown.
  if (reason === 'idem-indeterminate') return 507;
  if (reason === 'not-a-file'
      || reason === 'not-a-dir'
      || reason === 'unreadable'
      || reason === 'symlink'
      || reason === 'relative-path'
      || reason === 'bad-workdir') return 404;
  return 502;
}

const PINNED_ROOTS = Symbol('pinned-file-read-roots');

// Resolve authorization roots once, at the trusted boundary, and retain the
// filesystem identities that were approved. Callers keep and reuse the
// returned value rather than rebuilding it from request-controlled names.
export async function pinAllowedRoots(allowedRoots) {
  const roots = [];
  for (const root of allowedRoots || []) {
    try {
      const realPath = await fsp.realpath(root);
      const stat = await fsp.stat(realPath);
      if (!stat.isDirectory()) throw new Error('not a directory');
      roots.push(Object.freeze({ realPath, dev: stat.dev, ino: stat.ino }));
    } catch {
      throw new FileLinkDenied('bad-workdir');
    }
  }
  return Object.freeze({ [PINNED_ROOTS]: true, roots: Object.freeze(roots) });
}

// Synchronous pinning path for startup (server boot), before any request is
// served: resolving these pathnames later would let something replace them.
export function pinAllowedRootsSync(allowedRoots) {
  const roots = [];
  for (const root of allowedRoots || []) {
    try {
      const realPath = fs.realpathSync(root);
      const stat = fs.statSync(realPath);
      if (!stat.isDirectory()) throw new Error('not a directory');
      roots.push(Object.freeze({ realPath, dev: stat.dev, ino: stat.ino }));
    } catch {
      throw new FileLinkDenied('bad-workdir');
    }
  }
  return Object.freeze({ [PINNED_ROOTS]: true, roots: Object.freeze(roots) });
}

// The server's own state — the database and its WAL/SHM siblings, the
// preapprove key, the media tree, the write audit itself — can legitimately sit
// INSIDE a configured write root (the natural write-root for a deploy is the
// workspace, and a deploy could point one at the data directory). Nothing in
// the root/sensitivity checks would stop an authenticated client from
// overwriting the audit log it was just recorded in, or moving matron.db out
// from under the running process. So the server pins that set alongside the
// roots and the guards refuse it, belt-and-braces with the boot-time check that
// rejects the overlapping configuration outright.
// realpath() fails outright when the final component does not exist, and a
// protected path routinely does not exist yet (the audit log is created on the
// first write; a media directory on the first upload). Falling back to the
// LEXICAL spelling in that case is a hole: /outside/link/new-media, where
// `link` is a symlink into a write root, looks external at boot and becomes
// internal the moment the directory is created. So resolve the deepest ancestor
// that DOES exist and re-attach the unresolved suffix to it.
export function canonicalizeThroughExistingAncestor(targetPath) {
  const resolved = path.resolve(targetPath);
  let existing = resolved;
  const suffix = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(existing), ...suffix);
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') return resolved;
      const parent = path.dirname(existing);
      if (parent === existing) return resolved;
      suffix.unshift(path.basename(existing));
      existing = parent;
    }
  }
}

export function withProtectedPaths(pinnedRoots, protectedPaths) {
  const { isPinnedApi } = pinnedRootsOf(pinnedRoots);
  if (!isPinnedApi) throw new FileLinkDenied('bad-workdir');
  const resolved = [];
  for (const candidate of protectedPaths || []) {
    if (!candidate) continue;
    // Both spellings: the lexical one the operator configured, and the one the
    // filesystem will actually produce once every existing link is followed.
    for (const spelling of [path.resolve(candidate), canonicalizeThroughExistingAncestor(candidate)]) {
      if (!resolved.includes(spelling)) resolved.push(spelling);
    }
  }
  return Object.freeze({
    [PINNED_ROOTS]: true,
    roots: pinnedRoots.roots,
    protectedPaths: Object.freeze(resolved),
  });
}

// Rejects the protected path itself, anything inside it (a protected
// directory's contents), and any ancestor of it (a recursive delete of a parent
// would take the protected state with it).
function assertNotProtected(canonicalTarget, protectedPaths) {
  for (const protectedPath of protectedPaths) {
    if (contains(protectedPath, canonicalTarget) || contains(canonicalTarget, protectedPath)) {
      throw new FileLinkDenied('protected-path');
    }
  }
}

// Shared: unwrap a pinned-roots object. `isPinnedApi` is true when the caller
// passed a real pinned-roots object (the file API) rather than the legacy
// workdir form. An unresolved root-string array is rejected outright. An empty
// bare `[]` stays legacy (no-roots -> workdir fallback) for the ported bridge
// tests; the FILE API never reaches here with an empty pinned object (server
// treats no/empty roots as "disabled", F1/F4), and the guards below fail CLOSED
// on a zero-root pinned object as defense-in-depth.
function pinnedRootsOf(allowedRoots) {
  const isPinnedApi = allowedRoots?.[PINNED_ROOTS] === true;
  const pinnedRoots = isPinnedApi ? allowedRoots.roots : [];
  if (allowedRoots && (!Array.isArray(allowedRoots) || allowedRoots.length !== 0) && !isPinnedApi) {
    throw new FileLinkDenied('bad-workdir');
  }
  return { pinnedRoots, isPinnedApi };
}

// Shared: re-verify each pinned root still IS the same directory (dev+ino) it
// was at pin time, defeating a swap-a-root-for-a-symlink attack between boot
// and the request. Throws FileLinkDenied('bad-workdir') on any mismatch.
async function assertPinnedRootIdentity(pinnedRoots) {
  for (const root of pinnedRoots) {
    try {
      const current = await fsp.stat(root.realPath);
      if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino) {
        throw new Error('root identity changed');
      }
    } catch {
      throw new FileLinkDenied('bad-workdir');
    }
  }
}

function assertPinnedRootIdentitySync(pinnedRoots) {
  for (const root of pinnedRoots) {
    try {
      const current = fs.statSync(root.realPath);
      if (!current.isDirectory() || current.dev !== root.dev || current.ino !== root.ino) {
        throw new Error('root identity changed');
      }
    } catch {
      throw new FileLinkDenied('bad-workdir');
    }
  }
}

// --- Phase-2 write primitives -----------------------------------------------
//
// Node does not expose openat(2), renameat(2), mkdirat(2), or renameat2(2).
// Consequently a pathname-based mutation cannot be made perfectly immune to
// an ancestor rename/symlink swap. We minimize that residual by holding the
// deepest existing parent directory open, resolving its identity through
// /proc/self/fd, and checking the same fd again immediately before mutation.
// The remaining race requires a concurrent local writer able to alter an
// ancestor inside these root-owned write roots; that actor is outside the
// single-operator threat model (the same class as P1's accepted hard-link
// residual). Node also lacks renameat2(RENAME_NOREPLACE), so regular-file moves
// use link()+unlink(): link is an atomic no-clobber install, preserves the inode,
// and leaves both names safely reachable if the process dies before unlink.
// Directory moves reserve the destination before rename. A native *at-family
// binding would still be required to close the remaining ancestor-path races.

function fdRealPathSync(fd, fallbackPath) {
  if (process.platform === 'linux') return fs.readlinkSync(`/proc/self/fd/${fd}`);
  return fs.realpathSync(fallbackPath);
}

function isMissing(err) {
  return err?.code === 'ENOENT';
}

function lstatIfPresent(targetPath) {
  try {
    return fs.lstatSync(targetPath);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

function mostSpecificRoot(pinnedRoots, targetPath) {
  return pinnedRoots
    .filter((root) => contains(root.realPath, targetPath))
    .sort((a, b) => b.realPath.length - a.realPath.length)[0] || null;
}

function assertTrashProtected(targetPath) {
  if (targetPath.split(path.sep).filter(Boolean).includes('.matron-trash')) {
    throw new FileLinkDenied('trash-protected');
  }
}

// Returns a held directory identity for internal mutation helpers. The caller
// MUST close parentFd. For mkdir-p targets, the held fd is the deepest existing
// ancestor; other helpers require it to be the target's immediate parent.
function prepareWriteTarget(targetPath, writeRoots) {
  if (!path.isAbsolute(String(targetPath))) throw new FileLinkDenied('relative-path');
  const { pinnedRoots, isPinnedApi } = pinnedRootsOf(writeRoots);
  if (!isPinnedApi) throw new FileLinkDenied('bad-workdir');
  if (pinnedRoots.length === 0) throw new FileLinkDenied('outside-scope');
  assertPinnedRootIdentitySync(pinnedRoots);

  const resolved = path.resolve(targetPath);
  let candidate = path.dirname(resolved);
  let parentFd;
  while (true) {
    try {
      parentFd = fs.openSync(
        candidate,
        fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
      );
      break;
    } catch (err) {
      if (err?.code === 'ELOOP') throw new FileLinkDenied('symlink');
      if (err?.code !== 'ENOENT') throw new FileLinkDenied('unreadable');
      const next = path.dirname(candidate);
      if (next === candidate) throw new FileLinkDenied('unreadable');
      candidate = next;
    }
  }

  try {
    const parentStat = fs.fstatSync(parentFd);
    if (!parentStat.isDirectory()) throw new FileLinkDenied('unreadable');
    const pinnedAncestor = fdRealPathSync(parentFd, candidate);
    const relativeTarget = path.relative(candidate, resolved);
    if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`)) {
      throw new FileLinkDenied('outside-scope');
    }
    const canonicalTarget = path.resolve(pinnedAncestor, relativeTarget);
    const root = mostSpecificRoot(pinnedRoots, canonicalTarget);
    if (!root) throw new FileLinkDenied('outside-scope');
    if (isSensitivePath(canonicalTarget)) throw new FileLinkDenied('sensitive');
    assertTrashProtected(canonicalTarget);
    assertNotProtected(canonicalTarget, writeRoots.protectedPaths || []);
    for (const segment of relativeTarget.split(path.sep)) {
      if (Buffer.byteLength(segment) > MAX_NAME_BYTES) throw new FileLinkDenied('name-too-long');
    }
    const targetStat = lstatIfPresent(canonicalTarget);
    if (targetStat?.isSymbolicLink()) throw new FileLinkDenied('symlink');
    return {
      target: canonicalTarget,
      parentPath: path.dirname(canonicalTarget),
      pinnedAncestor,
      parentFd,
      parentDev: parentStat.dev,
      parentIno: parentStat.ino,
      pinnedRoots,
      root,
      targetStat,
    };
  } catch (err) {
    fs.closeSync(parentFd);
    throw err;
  }
}

function closePrepared(prepared) {
  if (prepared?.parentFd !== undefined) {
    try { fs.closeSync(prepared.parentFd); } catch {}
    prepared.parentFd = undefined;
  }
}

function assertNoSymlinkedNewAncestors(prepared) {
  const relativeParent = path.relative(prepared.pinnedAncestor, prepared.parentPath);
  if (!relativeParent) return;
  let cursor = prepared.pinnedAncestor;
  for (const segment of relativeParent.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stat = lstatIfPresent(cursor);
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new FileLinkDenied('symlink');
    if (!stat.isDirectory()) throw new FileLinkDenied('unreadable');
  }
}

function reverifyPrepared(prepared) {
  assertPinnedRootIdentitySync(prepared.pinnedRoots);
  let currentStat;
  let currentPath;
  try {
    currentStat = fs.fstatSync(prepared.parentFd);
    currentPath = fdRealPathSync(prepared.parentFd, prepared.pinnedAncestor);
  } catch {
    throw new FileLinkDenied('bad-workdir');
  }
  if (!currentStat.isDirectory()
      || currentStat.dev !== prepared.parentDev
      || currentStat.ino !== prepared.parentIno
      || currentPath !== prepared.pinnedAncestor
      || !contains(prepared.root.realPath, currentPath)) {
    throw new FileLinkDenied('bad-workdir');
  }
  assertNoSymlinkedNewAncestors(prepared);
}

function assertImmediateParent(prepared) {
  if (prepared.parentPath !== prepared.pinnedAncestor) {
    throw new FileLinkDenied('unreadable');
  }
}

function assertTargetIdentity(prepared, expectedStat) {
  const current = lstatIfPresent(prepared.target);
  if (!current
      || current.isSymbolicLink()
      || current.dev !== expectedStat.dev
      || current.ino !== expectedStat.ino) {
    throw new FileLinkDenied('unreadable');
  }
}

export function validateWriteTarget(targetPath, { writeRoots } = {}) {
  const prepared = prepareWriteTarget(targetPath, writeRoots);
  try {
    return prepared.target;
  } finally {
    closePrepared(prepared);
  }
}

function randomSibling(targetPath, marker = '.matron-tmp-') {
  return path.join(
    path.dirname(targetPath),
    `${marker}${process.pid}-${crypto.randomBytes(8).toString('hex')}`,
  );
}

function childPathThroughParentFd(prepared, name) {
  if (process.platform === 'linux') return `/proc/self/fd/${prepared.parentFd}/${name}`;
  return path.join(prepared.pinnedAncestor, name);
}

function writeAllSync(fd, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
    if (written === 0) throw new Error('zero-byte filesystem write');
    offset += written;
  }
}

// A durability barrier that runs AFTER the operation's commit point (the
// rename/link that made the change visible). The change has already happened,
// so a failure here cannot be "returned as an error" without lying: the caller
// would retry an operation that already succeeded and get a 404 on a source
// that is legitimately gone (Codex F4). Report success, and make the lost
// durability loud in the server log instead.
function postCommitFsync(fd, what) {
  try {
    fs.fsyncSync(fd);
  } catch (err) {
    console.error(`file-guard: post-commit fsync failed after ${what} — the change is applied but may not survive a crash`, err);
  }
}

function fsyncDirectoryPathSync(dirPath) {
  const fd = fs.openSync(
    dirPath,
    fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
  );
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fixedBytes(value) {
  if (Buffer.isBuffer(value)) return value;
  if (typeof value === 'string') return Buffer.from(value);
  if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  return null;
}

// `overwrite` defaults to FALSE: replacing an existing file is a destructive
// act, so the caller has to say so explicitly (plan T-2.4's server-enforced
// confirm). When it is allowed, the previous content is copied into the
// write-root's .matron-trash/ and fsynced BEFORE the replacement lands, so an
// overwrite is always recoverable.
// `dryRun` runs every check the live call runs and returns at the irreversibility
// boundary, immediately before the first mutating syscall. It deliberately does
// NOT get its own reduced validation path: a rollout validator that approves
// what the real call rejects is worse than no validator, and two code paths
// drift the moment either is edited.
export async function writeFileAtomic(targetPath, bytesOrStream, { writeRoots, maxBytes = Infinity, overwrite = false, dryRun = false } = {}) {
  if (!(maxBytes === Infinity || (Number.isSafeInteger(maxBytes) && maxBytes >= 0))) {
    throw new TypeError('maxBytes must be a non-negative safe integer or Infinity');
  }
  const bytes = fixedBytes(bytesOrStream);
  const isStream = bytes === null && bytesOrStream != null
    && (typeof bytesOrStream[Symbol.asyncIterator] === 'function'
      || typeof bytesOrStream[Symbol.iterator] === 'function');
  if (bytes === null && !isStream) throw new TypeError('bytesOrStream must be bytes or an iterable stream');
  if (bytes && bytes.length > maxBytes) throw new FileLinkDenied('too-large');

  const prepared = prepareWriteTarget(targetPath, writeRoots);
  let tmpPath;
  let tmpFd;
  let overwriteBackup;
  try {
    // P19a: every rejection is decided before the first byte touches the disk.
    if (prepared.targetStat && !overwrite) throw new FileLinkDenied('overwrite-conflict');
    if (prepared.targetStat && !prepared.targetStat.isFile()) throw new FileLinkDenied('dest-exists');
    assertImmediateParent(prepared);
    reverifyPrepared(prepared);
    if (dryRun) {
      // A streamed body's size is only knowable by reading it, and the cap is
      // part of what dry-run has to be able to answer — so consume and count,
      // discarding the bytes. This also drains the HTTP request body, which the
      // caller needs anyway to keep the connection reusable.
      if (isStream) {
        let size = 0;
        for await (const chunk of bytesOrStream) {
          const buffer = fixedBytes(chunk);
          if (buffer === null) throw new TypeError('stream chunks must be bytes');
          size += buffer.length;
          if (size > maxBytes) throw new FileLinkDenied('too-large');
        }
      }
      return prepared.target;
    }
    const tmpName = path.basename(randomSibling(prepared.target));
    tmpPath = childPathThroughParentFd(prepared, tmpName);
    const intendedMode = prepared.targetStat ? prepared.targetStat.mode & 0o777 : 0o600;
    tmpFd = fs.openSync(
      tmpPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      intendedMode,
    );
    // open(2)'s mode is masked by the process umask — the service runs with
    // UMask=0077, so a 0644 file replaced through here would come back 0600 and
    // silently cut off every other reader. fchmod is not masked (Codex R4).
    fs.fchmodSync(tmpFd, intendedMode);
    if (prepared.targetStat) {
      // A REPLACEMENT inherits the process identity unless it is told
      // otherwise, so an overwrite would quietly re-home a file owned by
      // someone else — revoking the original owner's access behind a 200. Same
      // contract as the cross-device move: preserve it, or refuse. (A create
      // has no prior owner; it is the server's file.)
      try {
        fs.fchownSync(tmpFd, prepared.targetStat.uid, prepared.targetStat.gid);
      } catch {
        throw new FileLinkDenied('metadata-preserve-failed');
      }
    }
    let size = 0;
    if (bytes) {
      writeAllSync(tmpFd, bytes);
      size = bytes.length;
    } else {
      for await (const chunk of bytesOrStream) {
        const buffer = fixedBytes(chunk);
        if (buffer === null) throw new TypeError('stream chunks must be bytes');
        size += buffer.length;
        if (size > maxBytes) throw new FileLinkDenied('too-large');
        writeAllSync(tmpFd, buffer);
      }
    }
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    tmpFd = undefined;
    reverifyPrepared(prepared);
    if (prepared.targetStat) overwriteBackup = preserveFileForOverwrite(prepared);
    reverifyPrepared(prepared);
    if (prepared.targetStat) assertTargetIdentity(prepared, prepared.targetStat);
    const targetThroughParent = childPathThroughParentFd(prepared, path.basename(prepared.target));
    if (overwrite) {
      // Replacing is the point: rename is the atomic swap, and the previous
      // content is already preserved in the trash above.
      fs.renameSync(tmpPath, targetThroughParent);
    } else {
      // A create must NOT clobber. rename() would silently replace a name a
      // racer created while the body was streaming (and with no backup, since
      // the target was absent at preparation) — link() is the atomic
      // no-replace install Node does give us, so EEXIST becomes the conflict
      // the caller asked for instead of unrecoverable data loss.
      try {
        linkNoReplace(tmpPath, targetThroughParent, fs.lstatSync(tmpPath));
      } catch (err) {
        // linkNoReplace's generic name for "something is already there"; for a
        // create-only WRITE the caller's actual choice is overwrite, so say so.
        if (err instanceof FileLinkDenied && err.reason === 'dest-exists') {
          throw new FileLinkDenied('overwrite-conflict');
        }
        throw err;
      }
      // linkNoReplace succeeded, so the caller's file EXISTS and this write is
      // committed. Removing the temp name is housekeeping: failing the request
      // on it would report a 500 for a file that is there, and the retry would
      // then hit overwrite-conflict (Codex R3-F3).
      try {
        fs.unlinkSync(tmpPath);
      } catch (err) {
        console.error(`file-guard: could not remove the temp name after committing ${prepared.target}; an orphan temp file remains`, err);
      }
    }
    tmpPath = undefined;
    overwriteBackup = undefined;
    postCommitFsync(prepared.parentFd, 'an atomic write');
    return prepared.target;
  } catch (err) {
    if (overwriteBackup) {
      try {
        removeOverwriteBackup(prepared, overwriteBackup);
      } catch (cleanupErr) {
        err.cleanupError = cleanupErr;
      }
    }
    throw err;
  } finally {
    if (tmpFd !== undefined) {
      try { fs.closeSync(tmpFd); } catch {}
    }
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch {}
    }
    closePrepared(prepared);
  }
}

export async function mkdirGuarded(targetPath, { writeRoots, dryRun = false } = {}) {
  const prepared = prepareWriteTarget(targetPath, writeRoots);
  try {
    if (prepared.targetStat) {
      if (!prepared.targetStat.isDirectory()) throw new FileLinkDenied('dest-exists');
      return prepared.target;
    }
    reverifyPrepared(prepared);
    if (dryRun) return prepared.target;
    // mkdir -p, one component at a time, fsyncing each parent after its child
    // lands. A single fsync of the deepest PRE-EXISTING ancestor would leave
    // the intermediate entries undurable, so a crash could lose part of a tree
    // the API (and the audit log) already called created (Codex R4).
    const opened = [];
    try {
      let parentFd = prepared.parentFd;
      let cursor = prepared.pinnedAncestor;
      for (const segment of path.relative(prepared.pinnedAncestor, prepared.target).split(path.sep)) {
        const child = path.join(cursor, segment);
        try {
          fs.mkdirSync(child);
        } catch (err) {
          if (err?.code !== 'EEXIST') throw err;
        }
        postCommitFsync(parentFd, 'a mkdir');
        // O_NOFOLLOW: a racer that swapped the component we just made for a
        // symlink does not get to be the directory we descend through.
        parentFd = fs.openSync(
          child,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
        );
        opened.push(parentFd);
        cursor = child;
      }
    } finally {
      for (const fd of opened) { try { fs.closeSync(fd); } catch {} }
    }
    return prepared.target;
  } finally {
    closePrepared(prepared);
  }
}

function reserveDestination(prepared, isDirectory) {
  reverifyPrepared(prepared);
  assertImmediateParent(prepared);
  if (lstatIfPresent(prepared.target)) throw new FileLinkDenied('dest-exists');
  try {
    if (isDirectory) {
      fs.mkdirSync(prepared.target, { mode: 0o700 });
      const stat = fs.lstatSync(prepared.target);
      return { isDirectory: true, dev: stat.dev, ino: stat.ino };
    }
    const fd = fs.openSync(
      prepared.target,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const stat = fs.fstatSync(fd);
      return { isDirectory: false, dev: stat.dev, ino: stat.ino };
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    if (err?.code === 'EEXIST') throw new FileLinkDenied('dest-exists');
    throw err;
  }
}

function assertReservationIdentity(targetPath, reservation) {
  const current = lstatIfPresent(targetPath);
  if (!current
      || current.isSymbolicLink()
      || current.isDirectory() !== reservation.isDirectory
      || current.dev !== reservation.dev
      || current.ino !== reservation.ino) {
    throw new FileLinkDenied('dest-exists');
  }
}

function releaseReservation(targetPath, reservation, onReleased) {
  assertReservationIdentity(targetPath, reservation);
  try {
    if (reservation.isDirectory) fs.rmdirSync(targetPath);
    else fs.unlinkSync(targetPath);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'EEXIST' || err?.code === 'ENOTEMPTY') {
      throw new FileLinkDenied('dest-exists');
    }
    throw err;
  }
  onReleased();
}

function linkNoReplace(sourcePath, destinationPath, expectedStat) {
  try {
    fs.linkSync(sourcePath, destinationPath);
  } catch (err) {
    if (err?.code === 'EEXIST') throw new FileLinkDenied('dest-exists');
    throw err;
  }
  const installed = lstatIfPresent(destinationPath);
  if (!installed
      || installed.isSymbolicLink()
      || !installed.isFile()
      || installed.dev !== expectedStat.dev
      || installed.ino !== expectedStat.ino) {
    throw new FileLinkDenied('unreadable');
  }
  return installed;
}

function removeInstalledFile(targetPath, installedStat) {
  const current = lstatIfPresent(targetPath);
  if (!current
      || current.isSymbolicLink()
      || current.dev !== installedStat.dev
      || current.ino !== installedStat.ino) {
    throw new FileLinkDenied('dest-exists');
  }
  fs.unlinkSync(targetPath);
}

function removeReservation(targetPath, reservation) {
  if (!reservation) return;
  try {
    assertReservationIdentity(targetPath, reservation);
    if (reservation.isDirectory) fs.rmdirSync(targetPath);
    else fs.unlinkSync(targetPath);
  } catch {}
}

function copyRegularFileForMove(
  source,
  destination,
  sourcePrepared,
  destinationPrepared,
  reservation,
  onReservationReleased,
) {
  let sourceFd;
  let tmpFd;
  let tmpPath;
  try {
    sourceFd = fs.openSync(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const sourceStat = fs.fstatSync(sourceFd);
    assertTargetIdentity(sourcePrepared, sourcePrepared.targetStat);
    tmpPath = randomSibling(destination);
    tmpFd = fs.openSync(
      tmpPath,
      fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
      sourcePrepared.targetStat.mode & 0o777,
    );
    // Not umask-masked, unlike the mode passed to open(2) above.
    fs.fchmodSync(tmpFd, sourceStat.mode & 0o777);
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < sourceStat.size) {
      const read = fs.readSync(sourceFd, buffer, 0, Math.min(buffer.length, sourceStat.size - position), position);
      if (read === 0) throw new FileLinkDenied('unreadable');
      writeAllSync(tmpFd, buffer.subarray(0, read));
      position += read;
    }
    // F3: the copy loop read exactly the byte count fstat reported when the
    // source was opened. A writer that appended (or rewrote) the file while we
    // were copying would have those bytes silently dropped by the unlink that
    // follows, so re-read the identity through the SAME fd and refuse rather
    // than destroy data we did not copy.
    const afterCopyStat = fs.fstatSync(sourceFd);
    if (afterCopyStat.size !== sourceStat.size
        || afterCopyStat.mtimeMs !== sourceStat.mtimeMs
        || afterCopyStat.ctimeMs !== sourceStat.ctimeMs) {
      throw new FileLinkDenied('source-changed');
    }
    // F2: a move must not quietly rewrite the file's metadata. The same-device
    // path preserves everything because it keeps the inode; the cross-device
    // copy has to restore it by hand. Ownership needs privilege we may not
    // have (and is already correct whenever the copy runs as the owner), so it
    // is best-effort; mode came from the open above and mtime/atime are set
    // last, after the final write that would otherwise bump them.
    try {
      fs.fchownSync(tmpFd, sourceStat.uid, sourceStat.gid);
    } catch (err) {
      // A move must not quietly re-home a file it cannot re-own: the source is
      // about to be unlinked, so losing the owner here is permanent. Refuse.
      // (Re-owning to the SAME uid/gid always succeeds, so this only fires for
      // a foreign-owned file the server has no right to reassign.)
      throw new FileLinkDenied('metadata-preserve-failed');
    }
    fs.futimesSync(tmpFd, sourceStat.atime, sourceStat.mtime);
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    tmpFd = undefined;
    const tmpStat = fs.lstatSync(tmpPath);
    fs.closeSync(sourceFd);
    sourceFd = undefined;
    reverifyPrepared(sourcePrepared);
    reverifyPrepared(destinationPrepared);
    assertTargetIdentity(sourcePrepared, sourcePrepared.targetStat);
    releaseReservation(destination, reservation, onReservationReleased);
    const installedStat = linkNoReplace(tmpPath, destination, tmpStat);
    let sourceUnlinked = false;
    try {
      fs.unlinkSync(tmpPath);
      tmpPath = undefined;
      fs.fsyncSync(destinationPrepared.parentFd);
      // Last possible moment before the source is destroyed: if it changed
      // after the copy, the destination does not carry those bytes. Roll back.
      const beforeUnlinkStat = lstatIfPresent(source);
      if (!beforeUnlinkStat
          || beforeUnlinkStat.isSymbolicLink()
          || beforeUnlinkStat.dev !== sourceStat.dev
          || beforeUnlinkStat.ino !== sourceStat.ino
          || beforeUnlinkStat.size !== sourceStat.size
          || beforeUnlinkStat.mtimeMs !== sourceStat.mtimeMs
          || beforeUnlinkStat.ctimeMs !== sourceStat.ctimeMs) {
        throw new FileLinkDenied('source-changed');
      }
      fs.unlinkSync(source);
      sourceUnlinked = true;
      postCommitFsync(sourcePrepared.parentFd, 'a cross-device move');
    } catch (err) {
      if (!sourceUnlinked) {
        try {
          removeInstalledFile(destination, installedStat);
          fs.fsyncSync(destinationPrepared.parentFd);
        } catch (rollbackErr) {
          err.rollbackError = rollbackErr;
        }
      }
      throw err;
    }
  } finally {
    if (sourceFd !== undefined) try { fs.closeSync(sourceFd); } catch {}
    if (tmpFd !== undefined) try { fs.closeSync(tmpFd); } catch {}
    if (tmpPath) try { fs.unlinkSync(tmpPath); } catch {}
  }
}

export async function moveGuarded(fromPath, toPath, { writeRoots, dryRun = false } = {}) {
  const source = prepareWriteTarget(fromPath, writeRoots);
  let destination;
  let reservation;
  try {
    destination = prepareWriteTarget(toPath, writeRoots);
    assertImmediateParent(source);
    assertImmediateParent(destination);
    if (!source.targetStat) throw new FileLinkDenied('unreadable');
    if (!source.targetStat.isFile() && !source.targetStat.isDirectory()) {
      throw new FileLinkDenied('unreadable');
    }
    if (source.pinnedRoots.some((root) => contains(source.target, root.realPath))) {
      throw new FileLinkDenied('outside-scope');
    }
    if (destination.targetStat) throw new FileLinkDenied('dest-exists');
    reverifyPrepared(source);
    reverifyPrepared(destination);
    assertTargetIdentity(source, source.targetStat);
    // The irreversibility boundary: everything above is a check, everything
    // below mutates. (A cross-device move is the one outcome dry-run cannot
    // predict — only the kernel's EXDEV tells us, and asking costs the move.)
    if (dryRun) return { from: source.target, to: destination.target };
    if (source.targetStat.isDirectory()) {
      reservation = reserveDestination(destination, true);
      assertReservationIdentity(destination.target, reservation);
      assertTargetIdentity(source, source.targetStat);
      reverifyPrepared(source);
      reverifyPrepared(destination);
      try {
        fs.renameSync(source.target, destination.target);
      } catch (err) {
        if (err?.code === 'EXDEV') throw new FileLinkDenied('cross-device-dir');
        throw err;
      }
      reservation = undefined;
      postCommitFsync(destination.parentFd, 'a directory move');
      if (source.parentPath !== destination.parentPath) postCommitFsync(source.parentFd, 'a directory move');
    } else {
      assertTargetIdentity(source, source.targetStat);
      reverifyPrepared(source);
      // Keep this destination check last: link() is the atomic no-replace
      // mutation. Unlike rename(), it cannot clobber a name raced into place.
      reverifyPrepared(destination);
      let installedStat;
      try {
        installedStat = linkNoReplace(source.target, destination.target, source.targetStat);
      } catch (err) {
        if (err?.code !== 'EXDEV') throw err;
        reservation = reserveDestination(destination, false);
        copyRegularFileForMove(
          source.target,
          destination.target,
          source,
          destination,
          reservation,
          () => { reservation = undefined; },
        );
        return { from: source.target, to: destination.target };
      }
      let sourceUnlinked = false;
      try {
        fs.fsyncSync(destination.parentFd);
        assertTargetIdentity(source, source.targetStat);
        fs.unlinkSync(source.target);
        sourceUnlinked = true;
        postCommitFsync(source.parentFd, 'a move');
      } catch (err) {
        const currentSource = lstatIfPresent(source.target);
        const sourceStillOriginal = currentSource
          && !currentSource.isSymbolicLink()
          && currentSource.dev === source.targetStat.dev
          && currentSource.ino === source.targetStat.ino;
        if (!sourceUnlinked && sourceStillOriginal) {
          try {
            removeInstalledFile(destination.target, installedStat);
            fs.fsyncSync(destination.parentFd);
          } catch (rollbackErr) {
            err.rollbackError = rollbackErr;
          }
        }
        throw err;
      }
    }
    return { from: source.target, to: destination.target };
  } finally {
    if (destination && reservation) removeReservation(destination.target, reservation);
    closePrepared(destination);
    closePrepared(source);
  }
}

function validateTrashDirectory(root) {
  const trashDir = path.join(root.realPath, '.matron-trash');
  const stat = lstatIfPresent(trashDir);
  if (!stat) return { trashDir, exists: false };
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new FileLinkDenied('trash-write-failed');
  let realTrash;
  try {
    realTrash = fs.realpathSync(trashDir);
  } catch {
    throw new FileLinkDenied('trash-write-failed');
  }
  if (realTrash !== trashDir || !contains(root.realPath, realTrash)) {
    throw new FileLinkDenied('trash-write-failed');
  }
  return { trashDir, exists: true, dev: stat.dev, ino: stat.ino };
}

function ensureTrashDirectory(prepared) {
  let trash = validateTrashDirectory(prepared.root);
  if (trash.exists) return { ...trash, created: false };
  let created = false;
  let createdTrash;
  try {
    fs.mkdirSync(trash.trashDir, { mode: 0o700 });
    created = true;
    const stat = fs.lstatSync(trash.trashDir);
    createdTrash = { trashDir: trash.trashDir, created: true, dev: stat.dev, ino: stat.ino };
  } catch (err) {
    if (err?.code !== 'EEXIST') throw new FileLinkDenied('trash-write-failed');
  }
  try {
    trash = validateTrashDirectory(prepared.root);
    if (!trash.exists) throw new FileLinkDenied('trash-write-failed');
    if (prepared.root.realPath === prepared.pinnedAncestor) fs.fsyncSync(prepared.parentFd);
    else fsyncDirectoryPathSync(prepared.root.realPath);
    return { ...trash, created };
  } catch (err) {
    removeCreatedTrashDirectory(createdTrash);
    throw err;
  }
}

function removeCreatedTrashDirectory(trash) {
  if (!trash?.created) return false;
  try {
    const current = fs.lstatSync(trash.trashDir);
    if (current.isSymbolicLink()
        || !current.isDirectory()
        || current.dev !== trash.dev
        || current.ino !== trash.ino) return false;
    fs.rmdirSync(trash.trashDir);
    return true;
  } catch {
    return false;
  }
}

function assertTrashDirectoryIdentity(root, trashDir, trashFd, expectedStat) {
  try {
    const fdStat = fs.fstatSync(trashFd);
    const pathStat = fs.lstatSync(trashDir);
    const fdPath = fdRealPathSync(trashFd, trashDir);
    const realPath = fs.realpathSync(trashDir);
    if (!fdStat.isDirectory()
        || pathStat.isSymbolicLink()
        || !pathStat.isDirectory()
        || fdStat.dev !== expectedStat.dev
        || fdStat.ino !== expectedStat.ino
        || pathStat.dev !== expectedStat.dev
        || pathStat.ino !== expectedStat.ino
        || fdPath !== trashDir
        || realPath !== trashDir
        || !contains(root.realPath, realPath)) {
      throw new Error('trash directory identity changed');
    }
  } catch {
    throw new FileLinkDenied('trash-write-failed');
  }
}

function trashName(sourcePath) {
  const utc = new Date().toISOString().replace(/[:.]/g, '-');
  const random = crypto.randomBytes(8).toString('hex');
  return `${utc}-${random}-${path.basename(sourcePath)}`;
}

// Preserves the file about to be replaced by linking its INODE into the trash.
// Not a byte copy: a copy is a photograph taken at one instant, and a writer
// touching the file between the snapshot and the replacement would have those
// bytes destroyed with only the stale copy left behind (Codex R3-F6). A link
// has no such window — the backup IS the file.
//
// When the link cannot be made (a write root spanning a bind mount -> EXDEV, a
// filesystem without hard links -> EPERM, an inode at its link limit ->
// EMLINK), the overwrite is REFUSED rather than downgraded to a racy copy:
// "we could not make this recoverable" is a 507 the operator can see, and
// silently trading recoverability for convenience is the one thing the trash
// exists to prevent. .matron-trash lives inside the file's own write root, so
// in every ordinary deployment this is same-device by construction.
function preserveFileForOverwrite(prepared) {
  if (!prepared.targetStat.isFile()) throw new FileLinkDenied('unreadable');
  const trash = ensureTrashDirectory(prepared);
  let trashFd;
  let linked = false;
  let backupPath;
  let installedStat;
  try {
    trashFd = fs.openSync(
      trash.trashDir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const trashStat = fs.fstatSync(trashFd);
    assertTrashDirectoryIdentity(prepared.root, trash.trashDir, trashFd, trashStat);
    assertTargetIdentity(prepared, prepared.targetStat);
    backupPath = path.join(trash.trashDir, trashName(prepared.target));
    let installed;
    try {
      installed = linkNoReplace(prepared.target, backupPath, prepared.targetStat);
    } catch (err) {
      backupPath = undefined;
      if (err instanceof FileLinkDenied) throw err;
      throw new FileLinkDenied('trash-write-failed');
    }
    installedStat = installed;
    fs.fsyncSync(trashFd);
    linked = true;
    return { path: backupPath, dev: installed.dev, ino: installed.ino, trash };
  } finally {
    // The link exists the moment linkNoReplace returns. If anything after it
    // fails, the overwrite does NOT happen — so the trash must not keep a
    // "previous version" of a replacement that never occurred, and retries must
    // not pile up links (Codex R4).
    if (!linked && backupPath && installedStat) {
      try {
        const current = lstatIfPresent(backupPath);
        if (current
            && !current.isSymbolicLink()
            && current.dev === installedStat.dev
            && current.ino === installedStat.ino) {
          fs.unlinkSync(backupPath);
          if (trashFd !== undefined) fs.fsyncSync(trashFd);
        }
      } catch (err) {
        console.error(`file-guard: could not remove the orphaned overwrite backup ${backupPath}`, err);
      }
    }
    if (trashFd !== undefined) try { fs.closeSync(trashFd); } catch {}
    if (!linked && removeCreatedTrashDirectory(trash)) {
      try { fsyncDirectoryPathSync(prepared.root.realPath); } catch {}
    }
  }
}

// The overwrite backup is made BEFORE the replacement commits, so a commit that
// fails must take the backup with it — otherwise the trash accumulates a
// "previous version" of a write that never happened. Identity-checked, so a
// racer that replaced the backup name is never the thing we delete.
function removeOverwriteBackup(prepared, backup) {
  assertPinnedRootIdentitySync(prepared.pinnedRoots);
  let trashFd;
  try {
    trashFd = fs.openSync(
      backup.trash.trashDir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const trashStat = fs.fstatSync(trashFd);
    assertTrashDirectoryIdentity(prepared.root, backup.trash.trashDir, trashFd, trashStat);
    if (trashStat.dev !== backup.trash.dev || trashStat.ino !== backup.trash.ino) {
      throw new FileLinkDenied('trash-write-failed');
    }
    const current = lstatIfPresent(backup.path);
    if (current) {
      if (current.isSymbolicLink()
          || !current.isFile()
          || current.dev !== backup.dev
          || current.ino !== backup.ino) {
        throw new FileLinkDenied('trash-write-failed');
      }
      fs.unlinkSync(backup.path);
      fs.fsyncSync(trashFd);
    }
  } finally {
    if (trashFd !== undefined) try { fs.closeSync(trashFd); } catch {}
  }
  if (removeCreatedTrashDirectory(backup.trash)) {
    fsyncDirectoryPathSync(prepared.root.realPath);
  }
}

export async function trashGuarded(targetPath, { writeRoots, recursive = false, dryRun = false } = {}) {
  const source = prepareWriteTarget(targetPath, writeRoots);
  let trash;
  let trashFd;
  let destination;
  let reservation;
  let trashCommitted = false;
  try {
    assertImmediateParent(source);
    if (!source.targetStat) {
      return { path: source.target, trashed: null, already_missing: true };
    }
    if (!source.targetStat.isFile() && !source.targetStat.isDirectory()) {
      throw new FileLinkDenied('unreadable');
    }
    if (source.pinnedRoots.some((root) => contains(source.target, root.realPath))) {
      throw new FileLinkDenied('outside-scope');
    }
    validateTrashDirectory(source.root);
    reverifyPrepared(source);
    assertTargetIdentity(source, source.targetStat);
    if (source.targetStat.isDirectory() && !recursive && fs.readdirSync(source.target).length > 0) {
      throw new FileLinkDenied('dir-not-empty');
    }
    reverifyPrepared(source);
    assertTargetIdentity(source, source.targetStat);
    if (dryRun) return { path: source.target, trashed: null, already_missing: false };
    trash = ensureTrashDirectory(source);
    trashFd = fs.openSync(
      trash.trashDir,
      fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW,
    );
    const trashStat = fs.fstatSync(trashFd);
    assertTrashDirectoryIdentity(source.root, trash.trashDir, trashFd, trashStat);
    destination = path.join(trash.trashDir, trashName(source.target));
    if (source.targetStat.isDirectory()) {
      fs.mkdirSync(destination, { mode: 0o700 });
      const stat = fs.lstatSync(destination);
      reservation = { isDirectory: true, dev: stat.dev, ino: stat.ino };
    } else {
      const reserveFd = fs.openSync(
        destination,
        fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = fs.fstatSync(reserveFd);
        reservation = { isDirectory: false, dev: stat.dev, ino: stat.ino };
      } finally {
        fs.closeSync(reserveFd);
      }
    }
    reverifyPrepared(source);
    assertTargetIdentity(source, source.targetStat);
    assertTrashDirectoryIdentity(source.root, trash.trashDir, trashFd, trashStat);
    try {
      fs.renameSync(source.target, destination);
      reservation = undefined;
      trashCommitted = true;
    } catch (err) {
      if (err?.code !== 'EXDEV' || source.targetStat.isDirectory()) {
        throw new FileLinkDenied('trash-write-failed');
      }
      const trashPrepared = {
        ...source,
        target: destination,
        parentPath: trash.trashDir,
        pinnedAncestor: trash.trashDir,
        parentFd: trashFd,
        parentDev: trashStat.dev,
        parentIno: trashStat.ino,
        targetStat: null,
      };
      try {
        copyRegularFileForMove(
          source.target,
          destination,
          source,
          trashPrepared,
          reservation,
          () => { reservation = undefined; },
        );
        trashCommitted = true;
      } catch {
        throw new FileLinkDenied('trash-write-failed');
      }
    }
    postCommitFsync(trashFd, 'a delete');
    postCommitFsync(source.parentFd, 'a delete');
    return { path: source.target, trashed: destination, already_missing: false };
  } finally {
    if (destination && reservation) removeReservation(destination, reservation);
    if (trashFd !== undefined) try { fs.closeSync(trashFd); } catch {}
    if (!trashCommitted) removeCreatedTrashDirectory(trash);
    closePrepared(source);
  }
}

// Serve-time boundary for CONTENT. Opens with O_NOFOLLOW (a symlink final
// component fails ELOOP), resolves the fd's REAL path via /proc/self/fd
// (immune to path swaps after open), then re-checks containment, sensitivity,
// type, and size before reading THROUGH THE FD. Throws FileLinkDenied for
// every rejection it detects; an unexpected system error propagates — callers
// must map ANY throw to a denial (404 default), not just FileLinkDenied.
export async function validateAndOpen(filePath, { workdir, allowedRoots, maxBytes = MAX_VIEW_BYTES, strictSnapshot = false } = {}) {
  let fd;
  try {
    if (!path.isAbsolute(String(filePath))) throw new FileLinkDenied('relative-path');
    const { pinnedRoots, isPinnedApi } = pinnedRootsOf(allowedRoots);
    // File API with zero roots -> fail CLOSED, never fall through to the
    // no-containment path (review F4).
    if (isPinnedApi && pinnedRoots.length === 0) throw new FileLinkDenied('outside-scope');
    try {
      fd = await fsp.open(
        path.resolve(filePath),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (err) {
      throw new FileLinkDenied(err.code === 'ELOOP' ? 'symlink' : 'unreadable');
    }
    // O_NONBLOCK prevents attacker-created FIFOs from wedging open(). Check the
    // descriptor before any further path work so special files are rejected
    // without attempting to read them.
    const stat = await fd.stat();
    if (!stat.isFile()) throw new FileLinkDenied('not-a-file');
    const realPath = process.platform === 'linux'
      ? await fsp.readlink(`/proc/self/fd/${fd.fd}`)
      : await fsp.realpath(path.resolve(filePath));
    if (pinnedRoots.length) {
      await assertPinnedRootIdentity(pinnedRoots);
      if (!pinnedRoots.some((root) => contains(root.realPath, realPath))) {
        throw new FileLinkDenied('outside-scope');
      }
    }
    if (isSensitivePath(realPath)) throw new FileLinkDenied('sensitive');
    if (!pinnedRoots.length && workdir) {
      let realWorkdir;
      try {
        realWorkdir = await fsp.realpath(workdir);
      } catch {
        throw new FileLinkDenied('bad-workdir');
      }
      if (!contains(realWorkdir, realPath)) throw new FileLinkDenied('outside-workdir');
    }
    if (stat.size > maxBytes) throw new FileLinkDenied('too-large');
    const buf = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const { bytesRead } = await fd.read(buf, offset, stat.size - offset, offset);
      if (bytesRead === 0) {
        if (strictSnapshot) throw new FileLinkDenied('unreadable');
        break;
      }
      offset += bytesRead;
    }
    const finalStat = await fd.stat();
    if (strictSnapshot && (
      finalStat.size !== stat.size ||
      finalStat.mtimeMs !== stat.mtimeMs ||
      finalStat.ctimeMs !== stat.ctimeMs
    )) throw new FileLinkDenied('unreadable');
    return { content: buf.subarray(0, offset), realPath, size: stat.size, mtimeMs: stat.mtimeMs };
  } finally {
    await fd?.close().catch(() => {});
  }
}

// Streaming serve-time boundary for CONTENT (review F3). Runs the SAME
// TOCTOU-safe validation as validateAndOpen (fd-pin via O_NOFOLLOW,
// /proc/self/fd realpath re-check, root-identity + containment + sensitivity),
// but reads NO bytes and returns the OPEN FileHandle so the caller can stream
// the validated descriptor with backpressure. The caller MUST close the
// returned handle (or destroy the stream it builds from it). On ANY validation
// failure the fd is closed here before throwing. The size cap is left to the
// caller (it decides 413-vs-stream and the Range window from `size` before a
// single byte is read), so a 100MB download never allocates 100MB.
export async function openGuarded(filePath, { allowedRoots } = {}) {
  let fd;
  let handedOff = false;
  try {
    if (!path.isAbsolute(String(filePath))) throw new FileLinkDenied('relative-path');
    const { pinnedRoots, isPinnedApi } = pinnedRootsOf(allowedRoots);
    if (isPinnedApi && pinnedRoots.length === 0) throw new FileLinkDenied('outside-scope');
    try {
      fd = await fsp.open(
        path.resolve(filePath),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (err) {
      throw new FileLinkDenied(err.code === 'ELOOP' ? 'symlink' : 'unreadable');
    }
    const stat = await fd.stat();
    if (!stat.isFile()) throw new FileLinkDenied('not-a-file');
    const realPath = process.platform === 'linux'
      ? await fsp.readlink(`/proc/self/fd/${fd.fd}`)
      : await fsp.realpath(path.resolve(filePath));
    if (pinnedRoots.length) {
      await assertPinnedRootIdentity(pinnedRoots);
      if (!pinnedRoots.some((root) => contains(root.realPath, realPath))) {
        throw new FileLinkDenied('outside-scope');
      }
    }
    if (isSensitivePath(realPath)) throw new FileLinkDenied('sensitive');
    handedOff = true;
    // The caller owns fd from here (streams then closes it).
    return { fd, size: stat.size, mtimeMs: stat.mtimeMs, realPath };
  } finally {
    if (!handedOff) await fd?.close().catch(() => {});
  }
}

// Guarded stat for META — fd-pinned like validateAndOpen but reads NO bytes,
// and accepts BOTH files and directories (a directory opens read-only; its
// final component is still symlink-proof via O_NOFOLLOW). Returns typed
// metadata for the client to pick a preview mode before fetching content.
export async function metaGuarded(targetPath, { allowedRoots } = {}) {
  let fd;
  try {
    if (!path.isAbsolute(String(targetPath))) throw new FileLinkDenied('relative-path');
    const { pinnedRoots, isPinnedApi } = pinnedRootsOf(allowedRoots);
    if (isPinnedApi && pinnedRoots.length === 0) throw new FileLinkDenied('outside-scope');
    try {
      fd = await fsp.open(
        path.resolve(targetPath),
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
      );
    } catch (err) {
      throw new FileLinkDenied(err.code === 'ELOOP' ? 'symlink' : 'unreadable');
    }
    const stat = await fd.stat();
    if (!stat.isFile() && !stat.isDirectory()) throw new FileLinkDenied('not-a-file');
    const realPath = process.platform === 'linux'
      ? await fsp.readlink(`/proc/self/fd/${fd.fd}`)
      : await fsp.realpath(path.resolve(targetPath));
    if (pinnedRoots.length) {
      await assertPinnedRootIdentity(pinnedRoots);
      if (!pinnedRoots.some((root) => contains(root.realPath, realPath))) {
        throw new FileLinkDenied('outside-scope');
      }
    }
    if (isSensitivePath(realPath)) throw new FileLinkDenied('sensitive');
    const kind = stat.isDirectory() ? 'dir' : 'file';
    return {
      realPath,
      kind,
      size: kind === 'file' ? stat.size : null,
      mtime: stat.mtimeMs,
      mime: kind === 'file' ? mimeForPath(realPath) : null,
      is_text: kind === 'file' ? isTextPath(realPath) : false,
    };
  } finally {
    await fd?.close().catch(() => {});
  }
}

// Net-new listing primitive. Realpath-resolves the dir, asserts it is inside a
// pinned read-root and not itself sensitive, reads the entries, then for EACH
// entry: drops it if its name/path is sensitive, drops it if its realpath
// escapes the roots (symlink-out defense) or is sensitive (symlink-to-secret),
// drops broken/unreadable entries. Caps at maxEntries with a truncated flag.
export function listDirGuarded(dirPath, { allowedRoots, maxEntries = MAX_LIST_ENTRIES } = {}) {
  if (!path.isAbsolute(String(dirPath))) throw new FileLinkDenied('relative-path');
  const { pinnedRoots, isPinnedApi } = pinnedRootsOf(allowedRoots);
  if (isPinnedApi && pinnedRoots.length === 0) throw new FileLinkDenied('outside-scope');

  let realDir;
  try {
    realDir = fs.realpathSync(path.resolve(dirPath));
  } catch {
    throw new FileLinkDenied('unreadable');
  }
  if (pinnedRoots.length) {
    assertPinnedRootIdentitySync(pinnedRoots);
    if (!pinnedRoots.some((root) => contains(root.realPath, realDir))) {
      throw new FileLinkDenied('outside-scope');
    }
  }
  if (isSensitivePath(realDir)) throw new FileLinkDenied('sensitive');

  let st;
  try {
    st = fs.statSync(realDir);
  } catch {
    throw new FileLinkDenied('unreadable');
  }
  if (!st.isDirectory()) throw new FileLinkDenied('not-a-dir');

  let dirents;
  try {
    dirents = fs.readdirSync(realDir, { withFileTypes: true });
  } catch {
    throw new FileLinkDenied('unreadable');
  }

  const entries = [];
  let truncated = false;
  for (const de of dirents) {
    const full = path.join(realDir, de.name);
    // Drop by listed name/path first (cheap; catches sensitively-named entries
    // regardless of what they point at).
    if (isSensitivePath(full)) continue;
    // Resolve the entry's real path: drops broken symlinks (throws) and lets
    // us enforce symlink-out + symlink-to-secret defenses.
    let entryReal;
    try {
      entryReal = fs.realpathSync(full);
    } catch {
      continue;
    }
    if (pinnedRoots.length && !pinnedRoots.some((root) => contains(root.realPath, entryReal))) continue;
    if (isSensitivePath(entryReal)) continue;
    let estat;
    try {
      estat = fs.statSync(full);
    } catch {
      continue;
    }
    if (entries.length >= maxEntries) {
      truncated = true;
      break;
    }
    const kind = estat.isDirectory() ? 'dir' : estat.isFile() ? 'file' : 'other';
    entries.push({
      name: de.name,
      kind,
      size: kind === 'file' ? estat.size : null,
      mtime: estat.mtimeMs,
      mime: kind === 'file' ? mimeForPath(entryReal) : null,
    });
  }
  return { realDir, entries, truncated };
}

// --- Extension -> MIME + text classification for content preview ------------
//
// Broader than the bridge's image-only map (lib/show-file.js) because the
// explorer previews markdown/code/pdf/media. SECURITY: script-capable types
// (.svg, .html, ...) are NOT given their real inline type here — they collapse
// to text/plain (see contentTypeFor) so nothing served inline on the journal
// origin can execute. Everything unrecognised is application/octet-stream.
const IMAGE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
};
const MEDIA_MIME = {
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.oga': 'audio/ogg',
  '.ogg': 'audio/ogg',
  '.flac': 'audio/flac',
  '.opus': 'audio/opus',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
};
// Extensions we render as text/code inline (highlight.js on the client). SVG
// and HTML are deliberately included as TEXT — the operator sees the source,
// and they never execute (served text/plain + nosniff).
const TEXT_EXTENSIONS = new Set([
  '.txt', '.text', '.md', '.markdown', '.rst', '.log', '.csv', '.tsv',
  '.json', '.jsonl', '.ndjson', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.properties',
  '.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.css', '.scss', '.sass', '.less',
  '.html', '.htm', '.xml', '.svg', '.vue', '.svelte', '.astro',
  '.py', '.rb', '.go', '.rs', '.c', '.h', '.cc', '.cpp', '.hpp', '.cxx',
  '.java', '.kt', '.kts', '.swift', '.m', '.mm', '.php', '.pl', '.pm', '.lua',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.sql', '.graphql', '.gql', '.proto', '.tf', '.hcl',
  '.gitignore', '.gitattributes', '.dockerignore', '.editorconfig', '.env.example',
]);
// Extensionless files that are conventionally text.
const TEXT_BASENAMES = new Set([
  'dockerfile', 'makefile', 'readme', 'license', 'licence', 'notice',
  'changelog', 'authors', 'contributors', 'copying', 'procfile', 'gemfile',
  'rakefile', 'brewfile', 'vagrantfile', 'jenkinsfile',
]);

export function isTextPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext && TEXT_EXTENSIONS.has(ext)) return true;
  const base = path.basename(filePath).toLowerCase();
  if (!ext && TEXT_BASENAMES.has(base)) return true;
  return false;
}

// The MIME advertised in list/meta responses (a hint for the client's preview
// dispatch). Note this is the LOGICAL type; the type actually served on the
// wire for content is decided by contentTypeFor (which downgrades text/code to
// text/plain for safety).
export function mimeForPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME[ext]) return IMAGE_MIME[ext];
  if (ext === '.pdf') return 'application/pdf';
  if (MEDIA_MIME[ext]) return MEDIA_MIME[ext];
  if (ext === '.md' || ext === '.markdown') return 'text/markdown';
  if (isTextPath(filePath)) return 'text/plain';
  return 'application/octet-stream';
}

// The content-type actually written on the wire, plus whether it is safe to
// render inline. Images/PDF/media get their real type inline. Anything
// text-classified is served as text/plain;charset=utf-8 so script-capable
// text (HTML/SVG/JS) shows as source and never executes. Everything else is
// application/octet-stream (download).
export function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_MIME[ext]) return { type: IMAGE_MIME[ext], inlineSafe: true };
  if (ext === '.pdf') return { type: 'application/pdf', inlineSafe: true };
  if (MEDIA_MIME[ext]) return { type: MEDIA_MIME[ext], inlineSafe: true };
  if (isTextPath(filePath)) return { type: 'text/plain; charset=utf-8', inlineSafe: true };
  return { type: 'application/octet-stream', inlineSafe: false };
}
