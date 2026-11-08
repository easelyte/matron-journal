import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { startTestServer } from './helpers.js'

// GET /contact: the landing page of an https invite link. The same bytes
// for every invite (the fields stay in the fragment), locked down, and only
// while federation is on.

const KEY = 'd'.repeat(64)
const on = () => startTestServer({ tokenKey: KEY, federationEnv: { federation: 'on', publicUrl: 'https://a.example' } })
const sha = (s) => `'sha256-${createHash('sha256').update(s).digest('base64')}'`
// The text between the page's own (one, lower-case) tags.
const between = (html, tag) => html.slice(html.indexOf(`<${tag}>`) + tag.length + 2, html.indexOf(`</${tag}>`))

test('the contact page is static, cache-free, referrer-free and runs only its own script', async (t) => {
  const s = await on()
  t.after(() => s.close())
  const r = await fetch(`${s.base}/contact`)
  assert.equal(r.status, 200)
  assert.equal(r.headers.get('content-type'), 'text/html; charset=utf-8')
  assert.equal(r.headers.get('cache-control'), 'no-store')
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(r.headers.get('x-frame-options'), 'DENY')
  const csp = r.headers.get('content-security-policy')
  assert.match(csp, /^default-src 'none'; /)
  assert.match(csp, /frame-ancestors 'none'/)
  const html = await r.text()
  const script = between(html, 'script')
  const style = between(html, 'style')
  assert.ok(csp.includes(`script-src ${sha(script)};`), 'the inline script is allowed by its hash')
  assert.ok(csp.includes(`style-src ${sha(style)};`))
  assert.equal((html.match(/<script/g) ?? []).length, 1)
  assert.doesNotMatch(html, /\b(src|href|action)=/, 'it loads and links nothing')
  assert.match(script, /'matron:\/\/contact\?'/)
  assert.match(script, /named !== location\.host/, 'only a link to this journal')
  const again = await (await fetch(`${s.base}/contact?t=x`)).text()
  assert.equal(again, html, 'nothing in the request changes the page')
  const head = await fetch(`${s.base}/contact`, { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(await head.text(), '')
  assert.equal((await fetch(`${s.base}/contact`, { method: 'POST' })).status !== 200, true)
})

test('the contact page is not there while federation is off', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  assert.equal((await fetch(`${s.base}/contact`)).status, 404)
})

// The page's script, run against a stand-in for the browser: a good link
// fills in who is asking and builds the matron:// link from the checked
// fields; anything else shows only "incomplete".
async function run(s, href, { clipboard = true } = {}) {
  const html = await (await fetch(`${s.base}/contact`)).text()
  const script = between(html, 'script')
  const els = {}
  const el = (id) => (els[id] ??= { id, hidden: ['bad', 'copied', 'manual'].includes(id), textContent: '', handlers: {}, addEventListener(e, f) { this.handlers[e] = f } })
  const u = new URL(href)
  const location = { href, host: u.host, hash: u.hash }
  const copied = []
  const navigator = clipboard ? { clipboard: { writeText: (x) => { copied.push(x); return Promise.resolve() } } } : {}
  const { runInNewContext } = await import('node:vm')
  runInNewContext(script, { document: { getElementById: el }, location, URL, URLSearchParams, navigator })
  return { els, location, copied }
}

test('the page reads the fragment and builds the app link only from checked fields', async (t) => {
  const s = await on()
  t.after(() => s.close())
  const TOKEN = 'A'.repeat(43), FP = 'a'.repeat(26)
  const good = `https://a.example/contact#v=1&j=a.example&u=alice&t=${TOKEN}&fp=${FP}`
  const { els, location, copied } = await run(s, good.replace('https://a.example/contact#', 'https://eve@a.example/contact?x=1#'))
  els.copy.handlers.click()
  assert.deepEqual(copied, [good], 'Copy gives the clean link, not the address bar')
  assert.equal(els.bad, undefined, 'the incomplete notice is never touched')
  assert.equal(els.who.textContent, 'alice@a.example')
  assert.equal(els.fp.textContent, 'aaaa aaaa aaaa aaaa aaaa aaaa aa')
  els.open.handlers.click()
  assert.equal(location.href, `matron://contact?v=1&j=a.example&u=alice&t=${TOKEN}&fp=${FP}`)
  const bare = await run(s, good, { clipboard: false })
  bare.els.copy.handlers.click()
  assert.deepEqual([bare.els.manual.hidden, bare.els.plain.textContent], [false, good], 'no clipboard: the link to copy by hand')
  const p443 = await run(s, good.replace('j=a.example', 'j=a.example%3A443'))
  assert.equal(p443.els.who.textContent, 'alice@a.example:443', 'an explicit :443 is this journal too')
  for (const bad of [
    good.replace('j=a.example', 'j=b.example'), good.replace('v=1', 'v=2'), good.replace(`t=${TOKEN}`, 't=x'),
    `${good}&x=1`, good.replace('u=alice', 'u=<b>'), 'https://a.example/contact', good.replace(`fp=${FP}`, 'fp=1'),
  ]) {
    const r = await run(s, bad)
    assert.equal(r.els.bad.hidden, false, bad)
    assert.equal(r.els.invite.hidden, true, bad)
    assert.equal(r.els.open?.handlers?.click, undefined, bad)
  }
})
