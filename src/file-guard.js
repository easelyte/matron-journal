// Path jail and secret-path policy for file viewer reads.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

export const MAX_VIEW_BYTES = 5 * 1024 * 1024;
// /download-disposition serves whole artifacts (bundles, archives) rather than
// rendering — larger, but still bounded — budget.
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

// Basename patterns applied to EVERY path segment (a sensitively-named
// directory denies its contents). The bridge's set, hardened to
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
  // 2026-09-27 hardening (maintainer review of the file viewer reads found
  // these reachable under a $HOME read-root):
  //   ~/.secrets holds operator-submitted secrets for up to an hour, and other
  //   secret files are named *_secret / *-secret rather than secrets.json.
  /^\.secrets?$/i,
  /[-_.]secrets?$/i,
  //   Bearer material with no .json/.txt extension: the journal agent-token,
  //   access-token files (e.g. ~/.supabase/access-token), and the bridge's
  //   *-agent-creds.txt / *-agent-token.txt next to the journal DB.
  /(^|[-_.])(agent|access|refresh|api|auth|bearer)[-_]?tokens?(\.(txt|json))?$/i,
  /(^|[-_.])creds?(\.(txt|json|ya?ml|toml))?$/i,
  //   Bridge state files: session map, secret-request ledger, in-flight turns,
  //   timers, agent rooms, queued-release / run-state outboxes, the journal
  //   cursor. They carry convo ids, room bindings and secret-request metadata.
  /^\.claude-matrix-/i,
  /^\.matron-bridge-/i,
  /^\.claude-(queued-release|run-state)-outbox\.json$/i,
  /^\.claude-subagent-running\.json$/i,
  /^run-state-outbox\.json$/i,
  /^journal-cursor\.json$/i,
  //   Shell / REPL history routinely holds pasted tokens.
  /^\.[a-z0-9]*_?history$/i,
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

// The service user's home directory is where dotfiles and dot-directories keep
// credentials the name patterns cannot enumerate (~/.acme.sh/account.conf,
// ~/.agent/approval_grant_secret, ~/.bashrc exports, tool caches). When a
// read-root is $HOME or an ancestor of it, every top-level dot entry under
// $HOME is denied — unless a configured root itself lives inside that dot
// entry (an operator who roots ~/.devtool/workspace explicitly opted in to
// that subtree, and only that subtree).
function isHomeDotPath(realPath, homeDir, pinnedRoots) {
  if (!homeDir || !contains(homeDir, realPath) || realPath === homeDir) return false;
  const first = path.relative(homeDir, realPath).split(path.sep)[0];
  if (!first.startsWith('.')) return false;
  return isInDeniedTree(realPath, path.join(homeDir, first), pinnedRoots);
}

// Read denial for the FILE API: the name/path denylist, the server's own
// state (database, WAL/SHM, preapprove key, media, and the data
// directory that also holds the bridge agent credentials), and the $HOME
// dot-entry rule. The legacy workdir form (no pinned roots object) only gets
// the denylist, as before.
export function isDeniedPath(realPath, allowedRoots) {
  if (isSensitivePath(realPath)) return true;
  if (allowedRoots?.[PINNED_ROOTS] !== true) return false;
  for (const denied of allowedRoots.readDenyPaths || []) {
    if (contains(denied, realPath)) return true;
  }
  for (const tree of allowedRoots.readDenyTrees || []) {
    if (isInDeniedTree(realPath, tree, allowedRoots.roots)) return true;
  }
  return isHomeDotPath(realPath, allowedRoots.homeDir || null, allowedRoots.roots);
}

// A denied TREE (e.g. the journal data directory) yields only to a root that
// was configured inside it, and only within that root: a broader root that
// merely contains the tree never reaches into it.
function isInDeniedTree(realPath, tree, pinnedRoots) {
  if (!contains(tree, realPath)) return false;
  return !pinnedRoots.some((root) => contains(tree, root.realPath) && contains(root.realPath, realPath));
}

// Path-boundary-safe containment: /a/b contains /a/b and /a/b/c, not /a/bc.
// The filesystem root contains everything (parent + sep would test '//').
export function contains(parent, child) {
  if (parent === path.sep) return true;
  return child === parent || child.startsWith(parent + path.sep);
}

export class FileLinkDenied extends Error {
  constructor(reason) {
    super(`file link denied: ${reason}`);
    this.name = 'FileLinkDenied';
    this.reason = reason;
  }
}

// Uniform denial->status so the denial reason never leaks which check tripped.
export function denialToStatus(reason) {
  if (reason === 'sensitive' || reason === 'outside-scope') return 403;
  if (reason === 'too-large') return 413;
  if (reason === 'not-a-file'
      || reason === 'unreadable'
      || reason === 'symlink'
      || reason === 'relative-path'
      || reason === 'bad-workdir') return 404;
  return 502;
}

const PINNED_ROOTS = Symbol('pinned-file-read-roots');

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

// Resolve the deepest existing ancestor so denied state paths remain protected
// even before a missing file or directory is created.
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

// Attach the read policy (see isDeniedPath) to a pinned-roots object. Rejects
// a filesystem-root `/` read-root outright: with it every path on the host is
// "inside scope" and the denylist becomes the only boundary. `homeDir` is the
// service user's home; it is canonicalized so a symlinked $HOME still matches
// the /proc/self/fd real paths the guards compare against.
export function withReadPolicy(pinnedRoots, { denyPaths = [], denyTrees = [], homeDir = null } = {}) {
  const { isPinnedApi } = pinnedRootsOf(pinnedRoots);
  if (!isPinnedApi) throw new FileLinkDenied('bad-workdir');
  if (pinnedRoots.roots.some((root) => root.realPath === path.sep)) {
    throw new Error('file API: a read-root of / is refused — it puts every path on the host in scope');
  }
  const spellingsOf = (list) => {
    const out = [];
    for (const candidate of list) {
      if (!candidate) continue;
      for (const spelling of [path.resolve(candidate), canonicalizeThroughExistingAncestor(candidate)]) {
        if (!out.includes(spelling)) out.push(spelling);
      }
    }
    return Object.freeze(out);
  };
  return Object.freeze({
    ...pinnedRoots,
    [PINNED_ROOTS]: true,
    roots: pinnedRoots.roots,
    readDenyPaths: spellingsOf(denyPaths),
    readDenyTrees: spellingsOf(denyTrees),
    homeDir: homeDir ? canonicalizeThroughExistingAncestor(homeDir) : null,
  });
}

// Unwrap trusted, identity-pinned roots; an empty set fails closed below.
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

// Streaming serve-time boundary for CONTENT. Uses fd-pinning via O_NOFOLLOW,
// /proc/self/fd realpath re-check, root identity, containment and sensitivity,
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
    if (isDeniedPath(realPath, allowedRoots)) throw new FileLinkDenied('sensitive');
    handedOff = true;
    // The caller owns fd from here (streams then closes it).
    return { fd, size: stat.size, mtimeMs: stat.mtimeMs, realPath };
  } finally {
    if (!handedOff) await fd?.close().catch(() => {});
  }
}

// Guarded stat for META — fd-pinned like openGuarded but reads NO bytes,
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
    if (isDeniedPath(realPath, allowedRoots)) throw new FileLinkDenied('sensitive');
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

// The MIME advertised in metadata responses (a hint for the client's preview
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
