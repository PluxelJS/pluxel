import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createTestHost, type TestHost } from '@pluxel/test'
import { hostEnv } from '@pluxel/host/environment'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin, TypstError, type TypstSession } from '@pluxel/plugin-typst'
import { createTypstSourceProject, type TypstSourceFiles } from '@pluxel/plugin-typst/source'
import { nodeModules } from '@pluxel/services/node'
import { WorkerTaskError } from '@pluxel/services/workers'
import type { ConsumerFailure } from './compile-contract'
import type { Plugin } from 'vite'
import { fontFamilies, sourceExample } from './source-example'

const run = promisify(execFile)
const maxClients = 8
const clientIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

export function consumerFailure(error: unknown): ConsumerFailure {
	const name = error instanceof Error ? error.name : 'UnknownError'
	const message = error instanceof Error ? error.message : String(error)
	const code =
		error instanceof Error && 'code' in error && typeof error.code === 'string'
			? error.code
			: undefined
	if (error instanceof TypstError)
		return {
			kind: 'typst',
			name,
			code: error.code,
			message,
			path: error.path,
			diagnostics: error.diagnostics.map((item) => ({ ...item })),
		}
	if (error instanceof WorkerTaskError)
		return { kind: 'worker', name, code: error.code, message, diagnostics: [] }
	if (error instanceof Error && (name === 'AbortError' || name === 'TimeoutError'))
		return { kind: 'cancelled', name, code: name, message, diagnostics: [] }
	if (
		error instanceof Error &&
		'syscall' in error &&
		'code' in error &&
		typeof error.code === 'string'
	)
		return { kind: 'io', name, code: error.code, message, diagnostics: [] }
	return { kind: 'unexpected', name, code: code ?? 'UNEXPECTED', message, diagnostics: [] }
}

interface Client {
	root: string
	session: TypstSession
	templateKey: string
	sourceRevision: number
	sourceKey: string
	tail: Promise<unknown>
	closing: boolean
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
	let size = 0
	const chunks: Buffer[] = []
	for await (const chunk of request) {
		size += chunk.length
		if (size > 8 * 1024 * 1024) throw new Error('Request exceeds 8 MiB')
		chunks.push(Buffer.from(chunk))
	}
	const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
	if (!value || typeof value !== 'object' || Array.isArray(value))
		throw new TypeError('Expected a JSON object')
	return value as Record<string, unknown>
}

/** Local consumer host; browser code only receives compiled previews and PDF bytes. */
export function consumerCompiler(): Plugin {
	let host: TestHost | undefined
	let typst: TypstPlugin
	let directory: string | undefined
	let closing: Promise<void> | undefined
	const clients = new Map<string, Promise<Client>>()

	async function closeClient(id: string): Promise<void> {
		const pending = clients.get(id)
		if (!pending) return
		const client = await pending
		client.closing = true
		await client.tail.catch(() => {})
		try {
			await client.session.dispose()
		} finally {
			clients.delete(id)
			await rm(client.root, { recursive: true, force: true })
		}
	}

	function close(): Promise<void> {
		return (closing ??= (async () => {
			try {
				const results = await Promise.allSettled([...clients.keys()].map(closeClient))
				results.push(...(await Promise.allSettled([host?.dispose()])))
				const failures = results.filter((result) => result.status === 'rejected')
				if (failures.length > 0)
					throw new AggregateError(
						failures.map((result) => result.reason),
						'Consumer resources failed to close',
					)
			} finally {
				if (directory) await rm(directory, { recursive: true, force: true })
			}
		})())
	}

	function getClient(id: string): Promise<Client> {
		const current = clients.get(id)
		if (current) return current
		if (clients.size >= maxClients)
			throw new Error(`At most ${maxClients} editor pages may be open`)
		const pending = (async () => {
			const root = join(directory!, id)
			try {
				await mkdir(join(root, 'project'), { recursive: true })
				await writeFile(join(root, 'project/main.typ'), '')
				const session = await typst.open({ root: join(root, 'project'), entry: 'main.typ' })
				return {
					root,
					session,
					templateKey: '',
					sourceRevision: -1,
					sourceKey: '',
					tail: Promise.resolve(),
					closing: false,
				}
			} catch (error) {
				clients.delete(id)
				await rm(root, { recursive: true, force: true })
				throw error
			}
		})()
		clients.set(id, pending)
		return pending
	}

	return {
		name: 'typst-consumer-compiler',
		async configureServer(server) {
			try {
				const files = await Promise.all(
					fontFamilies.map(async (family) => {
						const { stdout } = await run('fc-match', ['-f', '%{family}\n%{file}', family])
						const [matched, path] = stdout.trim().split('\n')
						if (!matched?.split(',').includes(family) || !path)
							throw new Error(`Fontconfig must provide ${family}`)
						return path
					}),
				)
				directory = await mkdtemp(join(tmpdir(), 'typst-consumer-'))
				host = await createTestHost({
					services: [
						nodeModules({
							root: resolve(
								dirname(fileURLToPath(import.meta.resolve('@pluxel/plugin-typst/package.json'))),
								'dist/artifacts/node',
							),
						}),
					],
				})
				// This is an isolated browser acceptance host, accessed only through public test APIs.
				await host.start(FontsPlugin, { initialConfig: { files, maxFontBytes: 32 * 1024 * 1024 } })
				typst = await host.start(TypstPlugin, { initialConfig: { maxSessions: maxClients } })
			} catch (error) {
				await close()
				throw error
			}

			server.middlewares.use((request, response, next) => {
				const routePath = request.url?.split('?')[0]
				if (routePath === '/example' && request.method === 'GET') {
					void sourceExample()
						.then((example) => {
							response.setHeader('Content-Type', 'application/json')
							return response.end(JSON.stringify(example))
						})
						.catch((error) => {
							response.statusCode = 500
							response.end(String(error))
						})
					return
				}
				if (routePath !== '/compile' && routePath !== '/pdf' && routePath !== '/session/close')
					return next()
				void (async () => {
					response.setHeader('Cache-Control', 'no-store')
					let snapshot: Pick<ConsumerFailure, 'clientRevision'> = {}
					try {
						if (closing) throw new Error('Consumer host is closing')
						const address = server.httpServer?.address()
						const port =
							address && typeof address === 'object' ? address.port : server.config.server.port
						const origins = [
							`http://127.0.0.1:${port}`,
							`http://localhost:${port}`,
							...(hostEnv.publicOrigin ? [hostEnv.publicOrigin] : []),
						]
						if (
							request.method !== 'POST' ||
							!origins.includes(request.headers.origin ?? '') ||
							!origins.some((origin) => new URL(origin).host === request.headers.host) ||
							request.headers['content-type']?.split(';')[0] !== 'application/json'
						) {
							response.statusCode = 403
							throw new Error('Only same-origin JSON POST requests are accepted')
						}
						const id = request.headers['x-typst-client']
						if (typeof id !== 'string' || !clientIdPattern.test(id))
							throw new Error('X-Typst-Client must be a page UUID')
						const body = await readJson(request)
						if (closing) throw new Error('Consumer host is closing')
						if (routePath === '/session/close') {
							await closeClient(id)
							response.statusCode = 204
							response.end()
							return
						}
						const client = routePath === '/compile' ? await getClient(id) : await clients.get(id)
						if (!client || client.closing) throw new Error('Editor session is closed')
						const result = client.tail.then(async () => {
							if (routePath === '/pdf') {
								if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 1)
									throw new Error('Expected a positive PDF revision')
								return client.session.exportPdf(body.revision as number)
							}
							if (!Number.isSafeInteger(body.revision) || (body.revision as number) < 0)
								throw new Error('Expected a nonnegative source revision')
							snapshot = { clientRevision: body.revision as number }
							const checked = createTypstSourceProject({
								files: body.files as TypstSourceFiles,
							}).snapshot().files
							if (
								typeof checked['main.typ'] !== 'string' ||
								Object.values(checked).some((value) => typeof value !== 'string')
							)
								throw new Error(
									'The browser example accepts a complete text file map with main.typ',
								)
							const key = JSON.stringify(
								Object.fromEntries(Object.entries(checked).sort(([a], [b]) => a.localeCompare(b))),
							)
							if (
								(body.revision as number) < client.sourceRevision ||
								(body.revision === client.sourceRevision && key !== client.sourceKey)
							) {
								response.statusCode = 409
								throw Object.assign(
									new Error('Source revision is stale or refers to a different snapshot'),
									{ code: 'CONFLICT' },
								)
							}
							// Source acceptance advances even when native compilation fails.
							client.sourceRevision = body.revision as number
							client.sourceKey = key
							const templateChanged = key !== client.templateKey
							const root = join(client.root, 'project')
							if (templateChanged) {
								await rm(root, { recursive: true, force: true })
								await mkdir(root)
								for (const [path, text] of Object.entries(checked)) {
									await mkdir(dirname(join(root, path)), { recursive: true })
									await writeFile(join(root, path), text)
								}
							}
							client.templateKey = ''
							const compiled = await client.session.update({
								...(templateChanged ? { template: { root, entry: 'main.typ' } } : {}),
								files: {},
							})
							client.templateKey = key
							return {
								clientRevision: body.revision,
								preview: { ...compiled.preview, data: [...compiled.preview.data] },
								diagnostics: compiled.diagnostics,
							}
						})
						client.tail = result.catch(() => {})
						const value = await result
						response.setHeader(
							'Content-Type',
							routePath === '/pdf' ? 'application/pdf' : 'application/json',
						)
						response.end(value instanceof Uint8Array ? value : JSON.stringify(value))
					} catch (error) {
						if (response.statusCode === 200) response.statusCode = 400
						response.setHeader('Content-Type', 'application/json')
						response.end(JSON.stringify({ ...consumerFailure(error), ...snapshot }))
					}
				})()
			})
		},
		closeBundle: close,
	}
}
