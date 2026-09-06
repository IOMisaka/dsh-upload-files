// Smoke test for dsh-upload-files host half with a mock plugin context.
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply } from '../lib/index.js'

const home = mkdtempSync(join(tmpdir(), 'dsu-test-'))
process.env.DSH_HOME = home

const routes = new Map()
const toolDefs = []
const ctx = {
  webServer: { register: ({ path, handler }) => { routes.set(path, handler); return () => routes.delete(path) } },
  tools: { register: (def) => { toolDefs.push(def); return () => {} } }
}
apply(ctx)

async function postUpload(payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8')
  const req = {
    method: 'POST',
    url: '/upload-files',
    [Symbol.asyncIterator]: async function* () { yield body }
  }
  let status, json
  const res = { writeHead: (s) => { status = s }, end: (b) => { json = JSON.parse(b) } }
  await routes.get('/upload-files')(req, res)
  return { status, json }
}

async function getHistory(url) {
  let status, json
  const res = { writeHead: (s) => { status = s }, end: (b) => { json = JSON.parse(b) } }
  await routes.get('/uploads/history')({ method: 'GET', url }, res)
  return { status, json }
}

// 1. upload two files, one with a hostile path-like name
const pdf = Buffer.from('%PDF-1.4 fake report content')
const r1 = await postUpload({ files: [
  { name: 'report.pdf', size: pdf.length, dataBase64: pdf.toString('base64') },
  { name: 'C:\\evil\\..\\notes.txt', mime: 'text/plain', dataBase64: Buffer.from('hello notes').toString('base64') }
]})
assert.equal(r1.status, 200)
assert.ok(r1.json.ok)
const dir = r1.json.directory
assert.ok(existsSync(join(dir, 'report.pdf')))
const notesName = r1.json.files[1].name
assert.ok(!notesName.includes('\\') && !notesName.includes('/'), 'sanitized name: ' + notesName)
assert.ok(existsSync(join(dir, notesName)))

// 2. re-upload same name → dedup suffix
const r2 = await postUpload({ files: [{ name: 'report.pdf', dataBase64: pdf.toString('base64') }] })
assert.equal(r2.status, 200)
assert.ok(existsSync(join(dir, 'report-1.pdf')), 'deduped file exists')

// 3. history endpoint with filter + limit
const hAll = await getHistory('/uploads/history?limit=50')
assert.equal(hAll.status, 200)
assert.equal(hAll.json.count, 2)
assert.ok(Array.isArray(hAll.json.entries))
const hFilt = await getHistory('/uploads/history?query=rep&limit=1')
assert.equal(hFilt.json.count, 1)
assert.equal(hFilt.json.entries[0].files.length, 1)

// 4. tool execute
const tool = toolDefs.find((t) => t.name === 'list_uploads')
assert.ok(tool, 'tool registered')
const outAll = await tool.execute({}, {})
assert.equal(outAll.count, 2)
assert.equal(outAll.entries[0].files.length, 1) // newest first: the dedup batch
const outFilt = await tool.execute({ query: 'REPORT' }, {})
assert.equal(outFilt.count, 2) // both batches contain a report.pdf (case-insensitive)
const outLimit = await tool.execute({ limit: 1 }, {})
assert.equal(outLimit.count, 1)
assert.throws(() => tool.execute({ limit: 0 }, {}), /limit/)

// 5. render produces text content
const rendered = tool.output.render({}, outAll)[0]
assert.ok(rendered.type === 'text' && rendered.text.includes('report.pdf'))

// 6. error paths
const bad1 = await postUpload({ files: [] })
assert.equal(bad1.status, 400)
assert.ok(!bad1.json.ok)
const bad2 = await getHistory('/uploads/history?limit=999')
assert.equal(bad2.status, 400)

// history file on disk is valid JSON with version
const hist = JSON.parse(readFileSync(join(dir, 'history.json'), 'utf8'))
assert.equal(hist.version, 1)
assert.equal(hist.entries.length, 2)

rmSync(home, { recursive: true, force: true })
console.log('smoke test OK —', dir)
