import { cp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { Miniflare, Request as WorkerRequest, Response as WorkerResponse } from 'miniflare'
import { build, type Plugin } from 'vite-plus'
import { expect, it } from 'vitest'
import { createWorkspace } from '../support/workspace'

it('reuses the isolate Host and isolates concurrent event IO, cancellation and response streams in workerd', async () => {
	await using workspace = await createWorkspace('cloudflare', ['core', 'host'])
	const { root } = workspace
	await writeFile(
		join(root, 'package.json'),
		'{"name":"cloudflare-host-fixture","private":true,"type":"module"}',
	)
	await cp(new URL('./fixtures/', import.meta.url), root, { recursive: true })
	const output = await build({
		configFile: false,
		root,
		logLevel: 'silent',
		oxc: { decorator: { legacy: true } },
		resolve: {
			conditions: ['workerd', 'worker', 'browser', 'module', 'production'],
		},
		plugins: [createPluginSemanticsPlugin({ root }).plugin as unknown as Plugin],
		build: {
			write: false,
			target: 'esnext',
			lib: { entry: join(root, 'entry.ts'), formats: ['es'] },
		},
	})
	const bundle = Array.isArray(output) ? output[0] : output
	if (!bundle || !('output' in bundle)) throw new Error('Expected a Worker bundle')
	const chunks = bundle.output.filter((chunk) => chunk.type === 'chunk')
	const entry = chunks.find((chunk) => chunk.isEntry)
	if (!entry) throw new Error('Expected a Worker entry')
	const modules = Object.fromEntries(
		chunks.map((chunk) => [chunk.fileName, { type: 'esm' as const, contents: chunk.code }]),
	)
	for (const chunk of chunks) {
		expect(
			[...chunk.imports, ...chunk.dynamicImports].filter((id) => !Object.hasOwn(modules, id)),
		).toEqual([])
	}
	expect(
		chunks
			.flatMap((chunk) => Object.keys(chunk.modules))
			.filter((id) => /(?:node:|__vite-browser-external|\/@zenfs(?:\/|\+))/.test(id)),
	).toEqual([])

	const preparing = Promise.withResolvers<void>()
	const secondAdmitted = Promise.withResolvers<void>()
	const cancelStart = Promise.withResolvers<void>()
	const release = Promise.withResolvers<void>()
	const streamReading = Promise.withResolvers<void>()
	const releaseStream = Promise.withResolvers<void>()
	const updating = Promise.withResolvers<void>()
	const queued = Promise.withResolvers<void>()
	const firstFetchStarted = Promise.withResolvers<void>()
	const releaseFirstFetch = Promise.withResolvers<void>()
	const vaultRead = Promise.withResolvers<void>()
	const releaseVault = Promise.withResolvers<void>()
	let preparations = 0
	const barriers: Record<string, () => void | Promise<void>> = {
		'/prepare'() {
			preparations++
			preparing.resolve()
			return release.promise
		},
		'/admitted': secondAdmitted.resolve,
		'/cancel-start': () => cancelStart.promise,
		'/hold-stream'() {
			streamReading.resolve()
			return releaseStream.promise
		},
		'/updating': updating.resolve,
		'/queued': queued.resolve,
		'/hold-vault'() {
			vaultRead.resolve()
			return releaseVault.promise
		},
	}
	const echo = (name: string) => ({
		type: 'fetcher' as const,
		async handler(request: WorkerRequest) {
			return new WorkerResponse(name + ': ' + (await request.text()))
		},
	})
	const received: { path: string; header: string | null }[] = []
	const worker = new Miniflare({
		host: '127.0.0.1',
		port: 0,
		workers: [
			{
				config: {
					name: 'cloudflare-host-fixture',
					compatibilityDate: '2026-11-03',
					compatibilityFlags: ['enable_request_signal', 'no_nodejs_compat', 'no_nodejs_compat_v2'],
					manifest: { mainModule: entry.fileName, modules },
					env: {
						LEFT: echo('left'),
						RIGHT: echo('right'),
						HOST_PROBE: { type: 'text', value: 'fixture-current' },
						NEXT_PROBE: { type: 'text', value: 'fixture-next' },
					},
				},
				dev: {
					unsafeDirectSockets: [{ host: '127.0.0.1', port: 0, proxy: false }],
					outboundService: {
						type: 'fetcher',
						async handler(request) {
							const { hostname, pathname } = new URL(request.url)
							if (hostname === 'coordination.test') {
								const enter = barriers[pathname]
								if (!enter) throw new Error('Unknown fixture barrier ' + pathname)
								await enter()
								return new WorkerResponse(null)
							}
							received.push({ path: pathname, header: request.headers.get('x-fixture') })
							if (pathname === '/first') {
								firstFetchStarted.resolve()
								await releaseFirstFetch.promise
							}
							return new WorkerResponse('from managed Fetch: ' + pathname)
						},
					},
				},
			},
		],
	})
	async function fetchReply(id: string, binding = 'left') {
		const response = await worker.dispatchFetch(`http://worker.test/${id}`, {
			method: 'POST',
			body: id,
			headers: { 'x-binding': binding },
		})
		const body = await response.text()
		if (!response.ok) throw new Error(`Worker returned ${response.status}: ${body}`)
		return JSON.parse(body)
	}
	try {
		const origin = await worker.unsafeGetDirectURL('cloudflare-host-fixture')
		const first = fetch(new URL('/boot-abort', origin))
		await Promise.race([preparing.promise, first])
		const second = fetchReply('second', 'right')
		// The second handler has entered the driver while the first is still awaiting startup IO.
		await Promise.race([secondAdmitted.promise, second])
		cancelStart.resolve()
		const cancelled = await first
		expect(cancelled.status).toBe(499)
		release.resolve()
		const survivor = await second
		expect(survivor).toMatchObject({
			ordinal: 1,
			event: 'right: second',
			generation: expect.any(String),
		})
		const firstWarm = fetchReply('first')
		await Promise.race([firstFetchStarted.promise, firstWarm])
		const waiting = fetchReply('third', 'right')
		// Observe admission from a third event so the queued request has no test IO keeping it alive.
		const waitForAdmission = async () => {
			await expect
				.poll(() => fetch(new URL('/admission', origin)).then((response) => response.json()))
				.toBe(true)
		}
		await Promise.race([waitForAdmission(), waiting])
		expect(received.some(({ path }) => path === '/third')).toBe(false)
		releaseFirstFetch.resolve()
		const [a, b] = await Promise.all([firstWarm, waiting])
		for (const [reply, id, binding] of [
			[a, 'first', 'left'],
			[b, 'third', 'right'],
		] as const) {
			expect(reply).toMatchObject({
				value: 'from managed Fetch: /' + id,
				event: binding + ': ' + id,
				nodeGlobals: false,
			})
		}
		expect(preparations).toBe(1)
		expect(a.generation).toBe(survivor.generation)
		expect(b.generation).toBe(survivor.generation)
		expect([a.ordinal, b.ordinal].sort()).toEqual([2, 3])
		expect(await fetchReply('cancelled')).toEqual({ cancelled: true })
		expect(received.map(({ path }) => path).sort()).toEqual(['/first', '/second', '/third'])
		expect(received.every(({ header }) => header === 'managed-fetch')).toBe(true)

		const abort = new AbortController()
		const pending = await fetch(new URL('/stream-abort', origin), { signal: abort.signal })
		const reader = pending.body!.getReader()
		try {
			const chunk = await reader.read()
			expect(new TextDecoder().decode(chunk.value)).toMatch(/^ready: /)
			const sibling = fetch(new URL('/stream-complete', origin))
			abort.abort()
			const completed = await sibling
			expect(completed.headers.get('Content-Type')).toBe('text/plain')
			await expect(completed.text()).resolves.toBe('ready: from managed Fetch: /stream-complete')
		} finally {
			abort.abort()
			reader.releaseLock()
		}
		await expect(
			fetch(new URL('/stream-error', origin)).then((response) => response.text()),
		).rejects.toThrow(/fetch failed|terminated/)
		await expect
			.poll(async () => {
				const results = await fetch(new URL('/settled', origin))
				return results.json()
			})
			.toEqual({
				'stream-abort': { calls: 1, cancelled: true },
				'stream-complete': { calls: 1, cancelled: false },
				'stream-error': { calls: 1, cancelled: false },
			})
		const held = await fetch(new URL('/stream-hold', origin))
		const contents = held.text()
		await Promise.race([streamReading.promise, contents])
		const update = fetch(new URL('/update', origin)).then((response) => response.json())
		await Promise.race([updating.promise, update])
		const afterUpdate = fetchReply('after-update')
		await Promise.race([queued.promise, afterUpdate])
		releaseStream.resolve()
		await expect(contents).resolves.toBe('ready: from managed Fetch: /stream-hold')
		await expect(update).resolves.toEqual({ catalogRevision: 2, settledBeforeCommit: 1 })
		await expect(afterUpdate).resolves.toMatchObject({
			generation: survivor.generation,
			revision: 1,
		})
		await expect(fetchReply('storage-limits')).resolves.toEqual({
			file: 'ENOTSUP',
			durableStore: 'DURABILITY_UNAVAILABLE',
			vaultWrite: 'READ_ONLY',
		})
		const holding = fetchReply('vault-hold')
		await Promise.race([vaultRead.promise, holding])
		const rejected = await worker.dispatchFetch('http://worker.test/vault-missing')
		expect(rejected.status).toBe(422)
		expect(await rejected.json()).toEqual({ code: 'MISSING_INPUT' })
		const retained = await fetchReply('vault-current')
		expect(retained).toEqual({
			value: 'fixture-current',
			source: 'env',
			writable: false,
			generation: survivor.generation,
		})
		const next = await fetchReply('vault-next')
		expect(next).toEqual({
			value: 'fixture-next',
			source: 'env',
			writable: false,
			generation: expect.any(String),
		})
		expect(next.generation).not.toBe(retained.generation)
		releaseVault.resolve()
		await expect(holding).resolves.toEqual({ before: retained, after: retained })
		await expect(fetchReply('vault-next')).resolves.toEqual(next)
		await expect(
			fetch(new URL('/close', origin)).then((response) => response.json()),
		).resolves.toEqual({ stops: 2 })
	} finally {
		release.resolve()
		releaseStream.resolve()
		cancelStart.resolve()
		releaseFirstFetch.resolve()
		releaseVault.resolve()
		await worker.dispose()
	}
}, 30_000)
