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
import path from 'node:path';

export const MAX_VIEW_BYTES = 5 * 1024 * 1024;
// /download-disposition serves whole artifacts (bundles, archives) rather than
// rendering — larger, but still bounded — budget.
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;
// Max entries returned per listing before the response is marked truncated
// (no silent caps — the client is told the listing was cut).
export const MAX_LIST_ENTRIES = 2000;

// Basename patterns: bridge PR #54 verbatim plus ^secrets?$. config.json is
// deliberate: this ecosystem's config.json files hold tokens. Patterns apply
// to every path segment (a sensitively-named directory denies its contents).
const SENSITIVE_BASENAME_PATTERNS = [
  /\.env(\..*)?$/i,
  /secrets?\.(json|ya?ml|toml|txt)$/i,
  /^secrets?$/i,
  /^credentials$/i,
  /credentials?\.(json|ya?ml|toml|txt)$/i,
  /\.(pem|key|p12|pfx|jks|keystore)$/i,
  /id_rsa|id_ed25519|id_ecdsa/i,
  /\.npmrc$/i,
  /\.netrc$/i,
  /token(s)?\.(json|txt)$/i,
  /service[-_]?account.*\.json$/i,
  /\.htpasswd$/i,
  /^config\.json$/i,
];

const SENSITIVE_PATH_PATTERNS = [
  /\/\.aws\//i,
  /\/\.docker\//i,
  /\/\.kube\//i,
  /\/\.ssh\//i,
  /\/\.gnupg\//i,
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
export function denialToStatus(reason) {
  if (reason === 'sensitive' || reason === 'outside-scope') return 403;
  if (reason === 'too-large') return 413;
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

// Shared: unwrap a pinned-roots object, rejecting an unresolved root-string
// array as an authorization boundary (empty array -> legacy "no roots, fall
// back to workdir" behaviour is preserved).
function pinnedRootsOf(allowedRoots) {
  const pinnedRoots = allowedRoots?.[PINNED_ROOTS] === true ? allowedRoots.roots : [];
  if (allowedRoots && (!Array.isArray(allowedRoots) || allowedRoots.length !== 0)
      && allowedRoots[PINNED_ROOTS] !== true) {
    throw new FileLinkDenied('bad-workdir');
  }
  return pinnedRoots;
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
    const pinnedRoots = pinnedRootsOf(allowedRoots);
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

// Guarded stat for META — fd-pinned like validateAndOpen but reads NO bytes,
// and accepts BOTH files and directories (a directory opens read-only; its
// final component is still symlink-proof via O_NOFOLLOW). Returns typed
// metadata for the client to pick a preview mode before fetching content.
export async function metaGuarded(targetPath, { allowedRoots } = {}) {
  let fd;
  try {
    if (!path.isAbsolute(String(targetPath))) throw new FileLinkDenied('relative-path');
    const pinnedRoots = pinnedRootsOf(allowedRoots);
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
  const pinnedRoots = pinnedRootsOf(allowedRoots);

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
