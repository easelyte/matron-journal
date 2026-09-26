import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer } from './helpers.js'
import { makeWellKnown, parseList } from '../src/well-known.js'

test('well-known: unset → 404 for both files, unauthenticated', async (t) => {
  const s = await startTestServer()
  t.after(() => s.close())
  for (const p of ['/.well-known/apple-app-site-association', '/.well-known/assetlinks.json']) {
    const r = await fetch(s.base + p)
    assert.equal(r.status, 404); assert.deepEqual(await r.json(), { error: 'not_found' })
  }
  assert.equal((await fetch(s.base + '/.well-known/other')).status, 401, 'anything else is the API')
})

test('well-known: configured → claims /u/* for the apps; served without a token; HEAD works', async (t) => {
  const s = await startTestServer({
    appleAppIds: ['ABCDE12345.be.yearbooks.matron', 'ABCDE12345.be.yearbooks.matron.dev'],
    androidPackage: 'be.yearbooks.matron',
    androidCertSha256: ['aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'],
  })
  t.after(() => s.close())
  const aasa = await fetch(s.base + '/.well-known/apple-app-site-association')
  assert.equal(aasa.status, 200)
  assert.equal(aasa.headers.get('content-type'), 'application/json')
  assert.deepEqual(await aasa.json(), {
    applinks: { details: [{ appIDs: ['ABCDE12345.be.yearbooks.matron', 'ABCDE12345.be.yearbooks.matron.dev'], components: [{ '/': '/u/*', comment: 'Matron tracker links' }] }] },
  })
  const al = await fetch(s.base + '/.well-known/assetlinks.json')
  assert.equal(al.status, 200)
  assert.deepEqual(await al.json(), [{
    relation: ['delegate_permission/common.handle_all_urls'],
    target: { namespace: 'android_app', package_name: 'be.yearbooks.matron', sha256_cert_fingerprints: ['AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99'] },
  }])
  const head = await fetch(s.base + '/.well-known/assetlinks.json', { method: 'HEAD' })
  assert.equal(head.status, 200); assert.ok(Number(head.headers.get('content-length')) > 0); assert.equal(await head.text(), '')
  assert.equal((await fetch(s.base + '/.well-known/assetlinks.json', { method: 'POST' })).status, 401)
})

test('well-known: one platform configured leaves the other 404; malformed values fail at construction', async (t) => {
  const s = await startTestServer({ appleAppIds: ['ABCDE12345.be.yearbooks.matron'] })
  t.after(() => s.close())
  assert.equal((await fetch(s.base + '/.well-known/apple-app-site-association')).status, 200)
  assert.equal((await fetch(s.base + '/.well-known/assetlinks.json')).status, 404)
  assert.deepEqual(parseList(' a, b ,,c '), ['a', 'b', 'c'])
  assert.deepEqual(parseList(undefined), [])
  assert.throws(() => makeWellKnown({ appleAppIds: ['not-an-app-id'] }), /MATRON_APPLE_APP_IDS/)
  assert.throws(() => makeWellKnown({ androidPackage: 'be.yearbooks.matron' }), /MATRON_ANDROID_CERT_SHA256/)
  assert.throws(() => makeWellKnown({ androidCertSha256: ['aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'] }), /MATRON_ANDROID_PACKAGE/)
  assert.throws(() => makeWellKnown({ androidPackage: 'be.yearbooks.matron', androidCertSha256: ['AA:BB'] }), /MATRON_ANDROID_CERT_SHA256/)
  assert.throws(() => makeWellKnown({ androidPackage: 'bad package', androidCertSha256: ['aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99'] }), /MATRON_ANDROID_PACKAGE/)
})
