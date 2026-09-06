/**
 * dsh-upload-files — host half.
 *
 * Registers two exact routes on the webServer and one agent tool:
 *
 *   POST /upload-files     { files: [{ name, mime?, size?, dataBase64 }] }
 *                          → writes every file into the dedicated uploads
 *                            directory (~/.dsh/uploads by default),
 *                            appends one history entry to history.json,
 *                            answers with the absolute paths written.
 *
 *   GET  /uploads/history?limit=&query=
 *                          → recent upload entries (newest first) for the
 *                            sidebar history panel.
 *
 *   GET  /uploads/open-dir
 *                          → opens the dedicated uploads directory in the
 *                            OS file manager (explorer/open/xdg-open). The
 *                            path is fixed server-side; no client input.
 *
 *   list_uploads tool      the agent-facing query interface: same history,
 *                           filtered by file-name substring, capped by limit;
 *                           results carry absolute paths so the agent can
 *                           process the files with its own file tools per
 *                           user instructions.
 *
 * Storage layout (all under $DSH_HOME/uploads):
 *   <original-file-name>            (deduped to "name-1.ext" on collision)
 *   history.json                    { version: 1, entries: [ … newest first ] }
 *
 * The server is loopback-only by DSH design; uploads are still bounded
 * (per-file / per-batch byte caps, batch file count) and every stored name
 * is sanitized to a single safe path segment.
 */
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-upload-files'
export const inject = ['webServer', 'tools']

const UPLOADS_DIR_NAME = 'uploads'
const HISTORY_FILE_NAME = 'history.json'
const MAX_FILE_BYTES = 50 * 1024 * 1024        // per file, decoded
const MAX_BATCH_BYTES = 200 * 1024 * 1024      // whole batch, decoded
const MAX_FILES_PER_BATCH = 100
const MAX_BODY_BYTES = Math.ceil((MAX_BATCH_BYTES * 8) / 6) + 1024 * 1024 // base64 wire form + JSON slack
const HISTORY_KEEP = 200                       // entries retained in history.json
const DEFAULT_LIMIT = 20
const MAX_LIMIT = 100

// ── DSH home resolution (mirrors @deepseek-ai/dsh-home-paths) ─────────────
function resolveDshHome() {
	const fromEnv = process.env.DSH_HOME
	return resolve(fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : join(homedir(), '.dsh'))
}

function uploadsDir() {
	return join(resolveDshHome(), UPLOADS_DIR_NAME)
}

/** Open the fixed uploads directory in the OS file manager (fire-and-forget). */
function openUploadsDirectory() {
	const dir = uploadsDir()
	mkdirSync(dir, { recursive: true })
	let command
	let args
	if (process.platform === 'win32') {
		command = 'explorer.exe'
		args = [dir]
	} else if (process.platform === 'darwin') {
		command = 'open'
		args = [dir]
	} else {
		command = 'xdg-open'
		args = [dir]
	}
	const child = spawn(command, args, { detached: true, stdio: 'ignore' })
	child.unref()
	return dir
}

// ── name sanitization / dedup ───────────────────────────────────────────────
const WINDOWS_RESERVED = new Set(['CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6'])

/** Reduce a client-supplied file name to one safe path segment. */
function sanitizeName(raw) {
	let base = String(raw ?? '').split(/[\\/]/).pop() ?? ''
	base = Array.from(base)
		.filter((ch) => {
			const code = ch.codePointAt(0)
			return code >= 32 && !'<>"\\|?*'.includes(ch)
		})
	.join('')
	base = base.replace(/^[\s.]+|[\s.]+$/g, '').slice(0, 180)
	if (base.length === 0) return 'file'
	const dot = base.lastIndexOf('.')
	const stem = dot > 0 ? base.slice(0, dot) : base
	if (WINDOWS_RESERVED.has(stem.toUpperCase())) base = 'file-' + base
	return base
}

function exists(path) {
	try { statSync(path); return true } catch { return false }
}

/** First free path for the name: as-is, then "stem-N.ext" until free. */
function uniquePath(dir, fileName) {
	const candidate = join(dir, fileName)
	if (!exists(candidate)) return candidate
	const dot = fileName.lastIndexOf('.')
	const stem = dot > 0 ? fileName.slice(0, dot) : fileName
	const ext = dot > 0 ? fileName.slice(dot) : ''
	for (let i = 1; i < 1000; i += 1) {
		const next = join(dir, stem + '-' + i + ext)
		if (!exists(next)) return next
	}
	throw new Error('cannot deduplicate ' + fileName + ': 1000 collisions')
}

// ── history (single-writer chain; atomic replace via tmp+rename) ────────────
let writeChain = Promise.resolve()

function readHistory() {
	const file = join(uploadsDir(), HISTORY_FILE_NAME)
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'))
		if (parsed && Array.isArray(parsed.entries)) return { version: 1, entries: parsed.entries }
	} catch {}
	return { version: 1, entries: [] }
}

function commitHistory(mutate) {
	writeChain = writeChain.then(async () => {
		const history = readHistory()
		mutate(history)
		history.entries = (history.entries ?? []).slice(0, HISTORY_KEEP)
		const dir = uploadsDir()
		mkdirSync(dir, { recursive: true })
		const target = join(dir, HISTORY_FILE_NAME)
		const tmp = target + '.tmp-' + process.pid + '-' + Date.now()
		writeFileSync(tmp, JSON.stringify(history, null, 2))
		renameSync(tmp, target)
	})
	return writeChain
}

function historyEntry(id, files) {
	return { id, uploadedAt: new Date().toISOString(), files }
}

// ── request plumbing ────────────────────────────────────────────────────────
async function readJsonBody(req) {
	const chunks = []
	let total = 0
	for await (const chunk of req) {
		total += chunk.length
		if (total > MAX_BODY_BYTES) throw new Error('request body exceeds ' + Math.round(MAX_BATCH_BYTES / 1024 / 1024) + ' MiB per batch')
		chunks.push(chunk)
	}
	if (total === 0) throw new Error('empty request body')
	return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function sendJson(res, status, payload) {
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
	res.end(JSON.stringify(payload))
}

function newId() {
	return 'u-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
}

// ── routes + tool ───────────────────────────────────────────────────────────
export function apply(ctx) {
	const disposers = []

	disposers.push(ctx.webServer.register({
		kind: 'exact',
		path: '/upload-files',
		handler: async (req, res) => {
			if (req.method !== 'POST') {
				sendJson(res, 405, { ok: false, message: 'method not allowed' })
				return
			}
			try {
				const body = await readJsonBody(req)
				const files = Array.isArray(body?.files) ? body.files : null
				if (files === null || files.length === 0) throw new Error('"files" must be a non-empty array')
				if (files.length > MAX_FILES_PER_BATCH) throw new Error('at most ' + MAX_FILES_PER_BATCH + ' files per batch')

				const dir = uploadsDir()
				mkdirSync(dir, { recursive: true })
				let decodedTotal = 0
				const written = []
				for (const item of files) {
					if (!item || typeof item !== 'object') throw new Error('each file entry must be an object')
					const dataBase64 = item.dataBase64
					if (typeof dataBase64 !== 'string' || dataBase64.length === 0) throw new Error('missing base64 payload for ' + String(item.name ?? '?'))
					const bytes = Buffer.from(dataBase64, 'base64')
					if (bytes.length > MAX_FILE_BYTES) throw new Error(String(item.name) + ': exceeds ' + Math.round(MAX_FILE_BYTES / 1024 / 1024) + ' MiB per file')
					decodedTotal += bytes.length
					if (decodedTotal > MAX_BATCH_BYTES) throw new Error('batch exceeds ' + Math.round(MAX_BATCH_BYTES / 1024 / 1024) + ' MiB total')
					const path = uniquePath(dir, sanitizeName(item.name))
					writeFileSync(path, bytes)
					written.push({ name: path.split(/[\\/]/).pop(), path, size: bytes.length })
				}

				const id = newId()
				await commitHistory((history) => {
					history.entries.unshift(historyEntry(id, written))
				})
				sendJson(res, 200, { ok: true, id, directory: dir, files: written })
			} catch (error) {
				sendJson(res, 400, { ok: false, message: String((error && error.message) || error) })
			}
		}
	}))

	disposers.push(ctx.webServer.register({
		kind: 'exact',
		path: '/uploads/history',
		handler: async (req, res) => {
			if (req.method !== 'GET') {
				sendJson(res, 405, { ok: false, message: 'method not allowed' })
				return
			}
			try {
				const url = new URL(req.url ?? '/', 'http://localhost')
				let limit = DEFAULT_LIMIT
				const rawLimit = url.searchParams.get('limit')
				if (rawLimit !== null) {
					limit = Number.parseInt(rawLimit, 10)
					if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('limit must be an integer in 1..' + MAX_LIMIT)
				}
				const query = (url.searchParams.get('query') ?? '').trim().toLowerCase()
				let entries = readHistory().entries
				if (query !== '') {
					entries = entries.filter((entry) =>
						Array.isArray(entry.files) && entry.files.some((file) => String(file?.name ?? '').toLowerCase().includes(query)))
				}
				entries = entries.slice(0, limit)
				sendJson(res, 200, { ok: true, directory: uploadsDir(), count: entries.length, entries })
			} catch (error) {
				sendJson(res, 400, { ok: false, message: String((error && error.message) || error) })
			}
		}
	}))

	disposers.push(ctx.webServer.register({
		kind: 'exact',
		path: '/uploads/open-dir',
		handler: async (req, res) => {
			if (req.method !== 'GET' && req.method !== 'POST') {
				sendJson(res, 405, { ok: false, message: 'method not allowed' })
				return
			}
			try {
				const dir = openUploadsDirectory()
				sendJson(res, 200, { ok: true, directory: dir })
			} catch (error) {
				sendJson(res, 500, { ok: false, message: String((error && error.message) || error) })
			}
		}
	}))

	// Agent-facing query tool over the same history.
	disposers.push(ctx.tools.register({
		name: 'list_uploads',
		description:
			'List files uploaded through the DSH Web UI upload icon (workspace header row in the sidebar). ' +
			'Files are stored in a dedicated directory (~/.dsh/uploads by default); every entry carries absolute file paths. ' +
			"Use it when the user refers to an uploaded file: find the matching entry here, then process that path with your own file tools (read/glob/pwsh) per the user's instructions.",
		parameters: {
			type: 'object',
			properties: {
				limit: { type: 'integer', description: 'Max entries to return, 1-' + MAX_LIMIT + ' (default ' + DEFAULT_LIMIT + ').' },
				query: { type: 'string', description: 'Case-insensitive substring filter on uploaded file names.' }
			},
			required: []
		},
		output: {
			schema: {
				type: 'object',
				additionalProperties: false,
				properties: {
					directory: { type: 'string' },
					count: { type: 'integer' },
					entries: {
						type: 'array',
						items: {
							type: 'object',
							additionalProperties: false,
							properties: {
								id: { type: 'string' },
								uploadedAt: { type: 'string' },
								files: {
									type: 'array',
									items: {
										type: 'object',
										additionalProperties: false,
										properties: { name: { type: 'string' }, path: { type: 'string' }, size: { type: 'integer' } }
									}
								}
							},
							required: ['id', 'uploadedAt', 'files']
						}
					}
				},
				required: ['directory', 'count', 'entries']
			},
			render: (_args, value) => [{
				type: 'text',
				text:
					'上传目录: ' + value.directory + '\n共 ' + value.count + ' 条记录：\n' +
					(value.entries.length === 0
						? '（无）'
						: value.entries.map((entry) =>
							'[' + entry.uploadedAt + '] ' + entry.files.map((file) => file.name + ' (' + file.size + ' B → ' + file.path + ')').join('; ')).join('\n'))
			}]
		},
		presentCall: (args) => ({ card: 'generic', title: '查询上传历史', kind: 'other', rawInput: args }),
		execute(args, _exec) {
			let limit = DEFAULT_LIMIT
			if (args.limit !== undefined && args.limit !== null) {
				limit = args.limit
				if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) throw new Error('limit must be an integer in 1..' + MAX_LIMIT)
			}
			const query = typeof args.query === 'string' ? args.query.trim().toLowerCase() : ''
			if (query.length > 200) throw new Error('query too long')
			let entries = readHistory().entries
			if (query !== '') {
				entries = entries.filter((entry) =>
					Array.isArray(entry.files) && entry.files.some((file) => String(file?.name ?? '').toLowerCase().includes(query)))
			}
			return { directory: uploadsDir(), count: Math.min(limit, entries.length), entries: entries.slice(0, limit) }
		}
	}))

	return () => { for (const dispose of disposers) dispose() }
}
