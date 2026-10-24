import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pluginNodeAddressOf } from '@pluxel/core'
import { requirePluginService } from '@pluxel/core/internal'
import { createHost, type PluginHost } from '@pluxel/host'
import { hostEnv } from '@pluxel/host/environment'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { TypstPlugin, TypstError, type TypstSession } from '@pluxel/plugin-typst'
import { generateTypstRegions, validateTypstDraft } from '@pluxel/plugin-typst/tiptap'
import { nodeModules } from '@pluxel/services/node'
import { WorkerTaskError } from '@pluxel/services/workers'
import type { ConsumerFailure } from './compile-contract'
import type { Plugin } from 'vite'
import { fontFamilies, initialSource } from './editor-config.mjs'
import { getExample } from './report-example.mjs'

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
	let host: PluginHost | undefined
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
				results.push(...(await Promise.allSettled([host?.close()])))
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
				await mkdir(root)
				await writeFile(join(root, 'main.typ'), initialSource)
				const session = await typst.open({ root, entry: 'main.typ' })
				return { root, session, templateKey: '', tail: Promise.resolve(), closing: false }
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
				host = await createHost({
					plugins: [FontsPlugin, TypstPlugin],
					services: [
						nodeModules({
							root: resolve(
								dirname(fileURLToPath(import.meta.resolve('@pluxel/plugin-typst/package.json'))),
								'dist/artifacts/node',
							),
						}),
					],
					configRecords: {
						initial: [
							{
								owner: pluginNodeAddressOf(FontsPlugin),
								config: { files, maxFontBytes: 32 * 1024 * 1024 },
							},
							{ owner: pluginNodeAddressOf(TypstPlugin), config: { maxSessions: maxClients } },
						],
					},
					state: { initial: { autoStart: [pluginNodeAddressOf(TypstPlugin)] } },
				})
				const report = await host.start()
				if (
					report.reconciliation.length > 0 ||
					(report.core.status === 'committed' && !report.core.summary.lifecycleReport.ok)
				)
					throw new Error(`Consumer host failed to start: ${JSON.stringify(report)}`)
				// Host currently has no public instance accessor; this dev adapter follows Studio's host bridge.
				const instance = requirePluginService(host.ctx).getInstance(TypstPlugin)
				if (!instance) throw new Error('TypstPlugin did not become ready')
				typst = instance
			} catch (error) {
				await close()
				throw error
			}

			server.middlewares.use((request, response, next) => {
				const routePath = request.url?.split('?')[0]
				if (routePath !== '/compile' && routePath !== '/pdf' && routePath !== '/session/close')
					return next()
				void (async () => {
					response.setHeader('Cache-Control', 'no-store')
					let snapshot: Pick<ConsumerFailure, 'clientRevision' | 'mapping'> = {}
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
							if (
								typeof body.source !== 'string' ||
								!Number.isSafeInteger(body.revision) ||
								(body.revision as number) < 1
							)
								throw new Error('Expected source text and a positive client revision')
							snapshot = { clientRevision: body.revision as number }
							const draft = body.draft as { templateId?: string } | undefined
							const example = getExample(draft?.templateId ?? '')
							const { config, parseData } = example
							const checked = validateTypstDraft({
								draft: body.draft,
								config,
								templateId: example.id,
								templateRevision: example.draft.templateRevision,
							})
							if (!checked.ok) throw new TypstError('INVALID_INPUT', JSON.stringify(checked.issues))
							const generated = generateTypstRegions({
								regions: checked.value.regions,
								config,
								data: parseData(checked.value.data),
								snapshotRevision: body.revision as number,
							})
							if (!generated.ok)
								throw new TypstError('INVALID_INPUT', JSON.stringify(generated.issues))
							snapshot.mapping = generated.value.mapping
							const key = JSON.stringify([body.source, generated.value.templateFiles])
							const templateChanged = key !== client.templateKey
							if (templateChanged) {
								await writeFile(join(client.root, 'main.typ'), body.source)
								for (const [path, source] of Object.entries(generated.value.templateFiles)) {
									await mkdir(dirname(join(client.root, path)), { recursive: true })
									await writeFile(join(client.root, path), source)
								}
							}
							client.templateKey = ''
							const files = Object.fromEntries(
								Object.entries(generated.value.inputFiles).map(([path, text]) => [
									path,
									{ kind: 'text' as const, text },
								]),
							)
							const compiled = await client.session.update({
								...(templateChanged ? { template: { root: client.root, entry: 'main.typ' } } : {}),
								files: {
									...files,
									...(example.id === 'operations-report'
										? {
												'/inputs/report/cover.svg': {
													kind: 'bytes' as const,
													bytes: await readFile(
														new URL('./public/examples/operations-cover.svg', import.meta.url),
													),
												},
											}
										: {}),
								},
							})
							client.templateKey = key
							return {
								clientRevision: body.revision,
								preview: { ...compiled.preview, data: [...compiled.preview.data] },
								mapping: generated.value.mapping,
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
