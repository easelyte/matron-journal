// GET /contact: the page an https invite link opens (federation-contacts.js
// inviteWebLink) when no Matron app claims it. The link's fields sit in the
// fragment, so this page is the same bytes for every invite: it never sees
// the token, and nor do the journal's logs or any proxy. Its own script
// reads the fragment in the browser and offers, only on a tap, the same
// fields as a matron:// link for an installed app, a copy of the link, and
// how to paste it in.
//
// Served only while federation is on (404 otherwise, like the federation
// well-known). Locked down: a CSP that allows nothing but its own inline
// script and style (by hash), no caching, no referrer, no framing. It makes
// no request and links nowhere but matron://contact.
import { createHash } from 'node:crypto'
import { json } from './http-body.js'

export const CONTACT_PATH = '/contact'

const STYLE = `
body{font:16px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:0;padding:24px;background:#f6f6f4;color:#1d1d1f}
main{max-width:30rem;margin:0 auto;background:#fff;border-radius:14px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:1.3rem;margin:0 0 12px}
dl{margin:16px 0;display:grid;grid-template-columns:auto 1fr;gap:6px 12px}
dt{color:#6e6e73}
dd{margin:0;overflow-wrap:anywhere}
code{font:15px ui-monospace,Menlo,monospace;overflow-wrap:anywhere;user-select:all}
.note{color:#6e6e73;font-size:.92rem}
.actions{display:flex;flex-wrap:wrap;gap:10px;margin:18px 0}
button{font:inherit;border:0;border-radius:10px;padding:10px 16px;cursor:pointer}
#open{background:#0a66d8;color:#fff}
#copy{background:#e8e8ed;color:#1d1d1f}
[hidden]{display:none}
@media (prefers-color-scheme:dark){body{background:#000;color:#f5f5f7}main{background:#1c1c1e;box-shadow:none}#copy{background:#3a3a3c;color:#f5f5f7}}
`

const SCRIPT = `
(function () {
  var TOKEN = /^[A-Za-z0-9_-]{43}$/, FP = /^[a-z2-7]{26}$/;
  var NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
  var HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*(?::\\d{1,5})?$/;
  function el(id) { return document.getElementById(id); }
  function bad() { el('invite').hidden = true; el('bad').hidden = false; }
  var p;
  try { p = new URLSearchParams(location.hash.slice(1)); } catch (e) { return bad(); }
  var keys = [];
  p.forEach(function (_, k) { keys.push(k); });
  var ok = keys.length === 5 && ['v', 'j', 'u', 't', 'fp'].every(function (k) { return keys.indexOf(k) >= 0; });
  var j = (p.get('j') || '').toLowerCase(), u = p.get('u') || '', t = p.get('t') || '', fp = (p.get('fp') || '').toLowerCase();
  // j as a URL writes it (an explicit :443 dropped), as the journal reads it.
  var named = '';
  try { named = new URL('https://' + j).host; } catch (e) { return bad(); }
  if (!ok || p.get('v') !== '1' || !HOST.test(j) || named !== location.host || !NAME.test(u) || !TOKEN.test(t) || !FP.test(fp)) return bad();
  el('who').textContent = u + '@' + j;
  el('journal').textContent = j;
  el('fp').textContent = fp.match(/.{1,4}/g).join(' ');
  var fields = new URLSearchParams({ v: '1', j: j, u: u, t: t, fp: fp }).toString();
  var app = 'matron://contact?' + fields;
  // What Copy hands over is the link rebuilt from the checked fields, not the
  // address bar, which may carry a query or user info the apps refuse.
  var link = 'https://' + j + '/contact#' + fields;
  el('open').addEventListener('click', function () { location.href = app; });
  // Where the clipboard is unavailable or refused, the link is shown to
  // select and copy by hand.
  var manual = function () { el('plain').textContent = link; el('manual').hidden = false; };
  el('copy').addEventListener('click', function () {
    var done = function () { el('copied').hidden = false; };
    if (navigator.clipboard) navigator.clipboard.writeText(link).then(done, manual);
    else manual();
  });
})();
`

const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex">
<title>Matron contact invite</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<section id="invite">
<h1>Contact invite</h1>
<p><strong id="who"></strong> invites you to be contacts on Matron.</p>
<dl>
<dt>Journal</dt><dd><code id="journal"></code></dd>
<dt>Fingerprint</dt><dd><code id="fp"></code></dd>
</dl>
<p class="note">Compare this fingerprint with them another way, in person or on a call, before you accept.</p>
<div class="actions">
<button id="open" type="button">Open in Matron</button>
<button id="copy" type="button">Copy link</button>
</div>
<p class="note" id="copied" hidden>Copied.</p>
<p class="note" id="manual" hidden>Copy this link: <code id="plain"></code></p>
<p class="note">If Matron didn't open, open it yourself, go to People, choose <strong>Open an invite link</strong> and paste this link. The link works once and lasts 7 days.</p>
</section>
<section id="bad" hidden>
<h1>This invite link is incomplete</h1>
<p>Part of the link is missing or changed. Ask the person who sent it for a new one.</p>
</section>
</main>
<script>${SCRIPT}</script>
</body>
</html>
`

const HEADERS = {
  'content-type': 'text/html; charset=utf-8',
  'content-length': String(Buffer.byteLength(HTML)),
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': `default-src 'none'; script-src ${sha(SCRIPT)}; style-src ${sha(STYLE)}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
}

export function makeContactPage(federation) {
  const on = !!federation?.enabled
  return function handleContactPage(req, res, url) {
    if (url.pathname !== CONTACT_PATH) return false
    if (req.method !== 'GET' && req.method !== 'HEAD') return false
    if (!on) { json(res, 404, { error: 'not_found' }); return true }
    res.writeHead(200, HEADERS)
    res.end(req.method === 'HEAD' ? undefined : HTML)
    return true
  }
}
