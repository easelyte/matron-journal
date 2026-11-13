import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { Writable } from 'node:stream'
import { makeFilesReadHandler, resolveFileReads } from '../src/files-read-http.js'
import { makeTmpDir } from './tmp-dir.js'

class Response extends Writable {
  headers = {}
  chunks = []
  statusCode = 200
  setHeader(name, value) { this.headers[name.toLowerCase()] = value }
  writeHead(status, headers = {}) {
    this.statusCode = status
    for (const [name, value] of Object.entries(headers)) this.setHeader(name, value)
  }
  _write(chunk, encoding, callback) { this.chunks.push(Buffer.from(chunk)); callback() }
  get body() { return Buffer.concat(this.chunks) }
}
const owner = { kind: 'client', userId: 1 }
function fixture() {
  const root = fs.realpathSync(makeTmpDir('matron-file-viewer-'))
  fs.writeFileSync(path.join(root, 'readme.md'), 'hello viewer\n')
  fs.writeFileSync(path.join(root, '.env'), 'PRIVATE=secret')
  const config = resolveFileReads({ fileReadRoots: [root], fileOwnerUserId: '1',
    fileHomeDir: null, procSelfFdAvailable: true, dbPath: ':memory:', mediaDir: path.join(root, 'state') })
  return { root, config, handle: makeFilesReadHandler(config) }
}
async function request(handle, url, who = owner, headers = {}) {
  const res = new Response()
  const rejected = (req, res, status, obj) => {
    res.writeHead(status, { 'cache-control': 'private, no-store' })
    res.end(JSON.stringify(obj))
  }
  const handled = await handle({ method: 'GET', headers }, res, new URL(url, 'http://x'), who, rejected)
  return { handled, res }
}

test('file viewer mount declines disabled routes and unrelated paths', async () => {
  assert.equal((await request(makeFilesReadHandler(), '/files/meta?path=/tmp')).handled, false)
  assert.equal((await request(fixture().handle, '/other')).handled, false)
})

test('file viewer owner gate rejects agents, other users, and an unset owner', async () => {
  const { config, handle } = fixture()
  for (const who of [{ kind: 'agent', userId: 1 }, { kind: 'client', userId: 2 }]) {
    const { res } = await request(handle, '/files/meta?path=/tmp', who)
    assert.equal(res.statusCode, 403)
    assert.equal(res.headers['cache-control'], 'private, no-store')
  }
  const { res } = await request(makeFilesReadHandler({ ...config, fileOwnerUserId: null }), '/files/meta?path=/tmp')
  assert.equal(res.statusCode, 500)
})

test('file viewer metadata uses the pinned read roots and refuses secrets and escapes', async () => {
  const { root, handle } = fixture()
  const { res } = await request(handle, `/files/meta?path=${encodeURIComponent(path.join(root, 'readme.md'))}`)
  assert.equal(res.statusCode, 200)
  const meta = JSON.parse(res.body)
  assert.equal(meta.kind, 'file')
  assert.equal(meta.size, 13)
  assert.equal(meta.is_text, true)
  for (const [file, status] of [[path.join(root, '.env'), 403], ['/etc/hosts', 403], ['relative', 400]]) {
    const { res } = await request(handle, `/files/meta?path=${encodeURIComponent(file)}`)
    assert.equal(res.statusCode, status)
  }
})

test('file viewer content streams exact bytes, ranges, and attachment headers', async () => {
  const { root, handle } = fixture()
  const url = `/files/content?path=${encodeURIComponent(path.join(root, 'readme.md'))}`
  const { res } = await request(handle, url)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.toString(), 'hello viewer\n')
  assert.equal(res.headers['x-content-type-options'], 'nosniff')
  const range = (await request(handle, url + '&disposition=attachment', owner, { range: 'bytes=6-11' })).res
  assert.equal(range.statusCode, 206)
  assert.equal(range.body.toString(), 'viewer')
  assert.equal(range.headers['content-range'], 'bytes 6-11/13')
  assert.match(range.headers['content-disposition'], /^attachment;/)
  assert.equal((await request(handle, url, owner, { range: 'bytes=999-' })).res.statusCode, 416)
  const secret = (await request(handle, `/files/content?path=${encodeURIComponent(path.join(root, '.env'))}`)).res
  assert.equal(secret.statusCode, 403)
  assert.ok(!secret.body.toString().includes('PRIVATE'))
})
