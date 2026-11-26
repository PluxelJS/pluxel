import { createServer, request as requestHttp, type Server } from 'node:http'
import { once } from 'node:events'
import * as fs from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { BasePlugin, Plugin, pluginNodeAddressEqual } from '@pluxel/core'
import { Passthrough } from '@pluxel/core/fs'
import { clearOutboundHttpNode, requireOutboundHttp } from '@pluxel/core/host'
import { requireHostDocuments } from '@pluxel/core/internal'
import { createTestHost } from '@pluxel/test'
import { expect, it, vi } from 'vitest'

@Plugin()
class OutboundClient extends BasePlugin {
	client() {
		return { fetch: this.ctx.fetch, wretch: this.ctx.wretch, root: this.ctx.root }
	}
}

it('uses one owner-bound transport for native Wretch and Fetch on an otherwise empty Host', async () => {
	const requests: Request[] = []
	await using host = await createTestHost({
		services: [],
		coreConfig: {
			http: {
				headers: { 'User-Agent': 'host', 'Accept-Language': 'en' },
				fetch: async (input) => {
					expect(input).toBeInstanceOf(Request)
					requests.push(input as Request)
					return Response.json({ ok: true }, { status: 200 })
				},
			},
		},
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const client = plugin.client()
	expect(plugin.client().wretch).toBe(client.wretch)
	expect(plugin.client().fetch).toBe(client.fetch)
	const manager = requireOutboundHttp(client.root)
	const updated = await manager.save(node, 0, { headers: { 'Accept-Language': 'zh-HK' } })
	await updated.cleanup
	const response = await client.wretch
		.headers({ 'USER-AGENT': 'plugin', Authorization: 'Bearer managed-by-plugin' })
		.get('https://example.test/private?token=hidden')
		.json()
	expect(response).toEqual({ ok: true })
	await client.fetch(
		new Request('https://example.test/other', {
			method: 'POST',
			headers: { 'Content-Type': 'text/plain' },
			body: 'body owned by the caller',
		}),
	)
	expect(requests[0]?.headers.get('user-agent')).toBe('plugin')
	expect(requests[0]?.headers.get('authorization')).toBe('Bearer managed-by-plugin')
	expect(requests.map((request) => request.headers.get('accept-language'))).toEqual([
		'zh-HK',
		'zh-HK',
	])
	expect(requests[1]?.headers.get('user-agent')).toBe('host')
	expect(await requests[1]?.text()).toBe('body owned by the caller')
	const snapshot = await manager.snapshot(node)
	expect(snapshot).toMatchObject({
		managed: true,
		records: 'requests',
		activity: [
			{ owner: node, lastOrigin: 'https://example.test', received: 2, failed: 0, denied: 0 },
		],
	})
})

it('evaluates the effective origin and redirect mode before handing off to Fetch', async () => {
	const requests: Request[] = []
	await using host = await createTestHost({
		coreConfig: {
			http: {
				allowedOrigins: ['https://allowed.test', 'https://other.test'],
				fetch: async (input) => {
					requests.push(input as Request)
					return new Response(null, { status: 302, headers: { location: 'https://other.test' } })
				},
			},
		},
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { fetch, root } = plugin.client()
	const manager = requireOutboundHttp(root)
	const restricted = await manager.save(node, 0, {
		allowedOrigins: ['https://allowed.test', 'https://outside.test'],
	})
	await restricted.cleanup
	await expect(fetch('https://outside.test')).rejects.toMatchObject({ code: 'origin_denied' })
	await expect(fetch(new Request('https://allowed.test'))).rejects.toMatchObject({
		code: 'redirect_denied',
	})
	await expect(fetch('https://allowed.test', { redirect: 'follow' })).rejects.toMatchObject({
		code: 'redirect_denied',
	})
	expect(requests).toEqual([])
	await expect(fetch('https://allowed.test')).rejects.toThrow(/redirect in error mode/)
	await expect(fetch('https://allowed.test', { redirect: 'error' })).rejects.toThrow(
		/redirect in error mode/,
	)
	await expect(
		fetch(new Request('https://allowed.test'), { redirect: 'manual' }),
	).resolves.toHaveProperty('status', 302)
	expect(requests.map(({ redirect }) => redirect)).toEqual(['manual', 'manual', 'manual'])
	const blocked = await manager.save(node, 1, { allowedOrigins: [] })
	await blocked.cleanup
	await expect(fetch('https://allowed.test')).rejects.toMatchObject({ code: 'origin_denied' })
	expect(requests).toHaveLength(3)
})

it('follows the caller signal selected by RequestInit and the owning generation', async () => {
	const requests: Request[] = []
	await using host = await createTestHost({
		coreConfig: {
			http: {
				fetch: async (input) => {
					requests.push(input as Request)
					return new Response(null, { status: 204 })
				},
			},
		},
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { fetch } = plugin.client()
	const url = 'https://service.test/'
	const inherited = AbortSignal.abort(new Error('original request cancelled'))
	const original = new Request(url, { signal: inherited })
	await expect(fetch(original, { signal: undefined })).rejects.toBe(inherited.reason)
	await fetch(original, { signal: null })

	const replacement = new AbortController()
	const reads: string[] = []
	const init = Object.freeze({
		get signal() {
			expect(this).toBe(init)
			reads.push('signal')
			return replacement.signal
		},
		get redirect() {
			reads.push('redirect')
			return 'error' as const
		},
	})
	const baseline = new Request(original, init)
	expect(baseline.redirect).toBe('error')
	const nativeReads = reads.splice(0)
	await fetch(original, init)
	expect(reads).toEqual(nativeReads)
	replacement.abort(new Error('replacement cancelled'))
	expect(requests[1]!.signal.reason).toBe(replacement.signal.reason)

	{
		// An unbound request may expose no signal in an embedded Fetch implementation.
		using _unbound = vi
			.spyOn(Request.prototype, 'signal', 'get')
			.mockReturnValueOnce(undefined as never)
		await fetch(url, { signal: undefined })
	}
	await host.stop(node)
	expect(requests[0]!.signal.reason).toMatchObject({ message: 'Plugin owner stopped' })
	expect(requests[2]!.signal.reason).toMatchObject({ message: 'Plugin owner stopped' })
})

it.each(['off', 'summary'] as const)('keeps rules applied with %s records', async (records) => {
	await using host = await createTestHost({
		coreConfig: {
			http: {
				records,
				allowedOrigins: ['https://allowed.test'],
				fetch: async () => new Response(null, { status: 204 }),
			},
		},
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { fetch, root } = plugin.client()
	const management = requireOutboundHttp(root)
	await expect(fetch('https://allowed.test')).resolves.toHaveProperty('status', 204)
	await expect(fetch('https://outside.test')).rejects.toMatchObject({ code: 'origin_denied' })
	expect(management.logs).toBeUndefined()
	await expect(management.snapshot(null)).resolves.toMatchObject({
		managed: true,
		records,
		activity: records === 'off' ? [] : [{ owner: node, received: 1, denied: 1 }],
	})
})

it('uses a declared unmanaged Fetch while keeping caller and owner cancellation', async () => {
	const entered = Promise.withResolvers<void>()
	const transport = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
		const request = new Request(input, init)
		request.signal.throwIfAborted()
		if (new URL(request.url).pathname === '/header')
			return new Response(request.headers.get('x-origin'))
		if (new URL(request.url).pathname !== '/pending') return new Response('worker binding')
		return await new Promise<Response>((_resolve, reject) => {
			request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
			entered.resolve()
		})
	})
	await using host = await createTestHost({
		coreConfig: { http: { managed: false, fetch: transport } },
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { fetch, wretch, root } = plugin.client()
	const manager = requireOutboundHttp(root)
	// An inactive document is neither restored by the client nor consulted by Management reads.
	await requireHostDocuments(root, 'outbound-http').put('policy.json', '{')
	expect(manager.logs).toBeUndefined()
	const status = await manager.snapshot(node)
	expect(status.managed).toBe(false)
	expect(status.owner && pluginNodeAddressEqual(status.owner, node)).toBe(true)
	await expect(manager.save(node, 0, {})).rejects.toMatchObject({ code: 'management_disabled' })
	const request = new Request('https://service.internal/')
	const response = await fetch(request)
	await expect(response.text()).resolves.toBe('worker binding')
	expect(transport.mock.calls[0]?.[0]).toBe(request)
	await expect(wretch.get('https://service.internal/').text()).resolves.toBe('worker binding')
	const forwarded = new Request(request, { headers: { 'x-origin': 'ingress' } })
	const fromIngress = await fetch('https://service.internal/header', forwarded)
	await expect(fromIngress.text()).resolves.toBe('ingress')
	const caller = new AbortController()
	const reason = new Error('caller stopped')
	caller.abort(reason)
	await expect(fetch(new Request(request, { signal: caller.signal }))).rejects.toBe(reason)
	const pending = fetch('https://service.internal/pending').catch((error: unknown) => error)
	await entered.promise
	await host.stop(node)
	expect(await pending).toMatchObject({ message: 'Plugin owner stopped' })
	await expect(wretch.get('https://service.internal/').text()).rejects.toThrow(
		'Plugin owner stopped',
	)
})

it('rejects observations or policy fields when management is disabled', async () => {
	for (const http of [
		{ managed: false, records: 'off' },
		{ managed: false, allowedOrigins: [] },
	] as const) {
		await expect(createTestHost({ coreConfig: { http: http as never } })).rejects.toThrow(
			/\[core.http\] unmanaged options includes unsupported/,
		)
	}
})

it('removes dormant overrides when a node is removed in unmanaged mode', async () => {
	await using host = await createTestHost({ coreConfig: { http: { managed: false } } })
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { root } = plugin.client()
	const owner = { definition: node.definition, variant: 'fork', forkId: 'expired' } as const
	const documents = requireHostDocuments(root, 'outbound-http')
	await documents.put(
		'policy.json',
		JSON.stringify({
			version: 1,
			revision: 1,
			defaults: { timeoutMs: 2_000 },
			nodes: [{ owner, settings: { allowedOrigins: [] } }],
		}),
	)
	await clearOutboundHttpNode(root, owner)
	expect(JSON.parse((await documents.getText('policy.json'))!)).toEqual({
		version: 1,
		revision: 2,
		defaults: { timeoutMs: 2_000 },
		nodes: [],
	})
})

it('revalidates queued requests when a new policy is applied and bounds queue admission', async () => {
	const sent = Promise.withResolvers<void>()
	const release = Promise.withResolvers<Response>()
	let requests = 0
	await using host = await createTestHost({
		coreConfig: {
			http: {
				maxConcurrentRequests: 1,
				maxQueuedRequests: 1,
				fetch: async (input) => {
					requests++
					const { signal } = input as Request
					signal.addEventListener('abort', () => release.reject(signal.reason), { once: true })
					sent.resolve()
					return release.promise
				},
			},
		},
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { fetch, root } = plugin.client()
	const first = fetch('https://first.test')
	void first.catch((): void => undefined)
	await sent.promise
	const queued = fetch('https://second.test').catch((error: unknown) => error)
	await expect(fetch('https://third.test')).rejects.toMatchObject({ code: 'queue_full' })
	const restricted = await requireOutboundHttp(root).save(node, 0, {
		allowedOrigins: ['https://first.test'],
	})
	await restricted.cleanup
	release.resolve(new Response(null, { status: 204 }))
	await first
	await expect(queued).resolves.toMatchObject({ code: 'origin_denied' })
	expect(requests).toBe(1)
})

it('withdraws a cached client, blocked work and response streams with the owning generation', async () => {
	const started = Promise.withResolvers<void>()
	let inFlight = 0
	await using host = await createTestHost({
		coreConfig: {
			http: {
				maxConcurrentRequests: 1,
				maxQueuedRequests: 1,
				fetch: async (input) => {
					const request = input as Request
					if (new URL(request.url).pathname === '/body') {
						return new Response(
							new ReadableStream({
								start(controller) {
									request.signal.addEventListener(
										'abort',
										() => controller.error(request.signal.reason),
										{ once: true },
									)
								},
							}),
						)
					}
					inFlight++
					started.resolve()
					return new Promise<Response>((_, reject) => {
						request.signal.addEventListener('abort', () => reject(request.signal.reason), {
							once: true,
						})
					})
				},
			},
		},
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const client = plugin.client()
	const response = await client.fetch('https://example.test/body')
	const body = response.text().catch((error: unknown) => error)
	const active = client.fetch('https://example.test/active').catch((error: unknown) => error)
	await started.promise
	const queued = client.fetch('https://example.test/queued').catch((error: unknown) => error)
	await expect(client.fetch('https://example.test/full')).rejects.toMatchObject({
		code: 'queue_full',
	})
	await host.stop(node)
	await expect(Promise.all([active, queued, body])).resolves.toMatchObject([
		{ message: 'Plugin owner stopped' },
		{ message: 'Plugin owner stopped' },
		{ message: 'Plugin owner stopped' },
	])
	await host.start(node)
	await expect(client.fetch('https://example.test/stale')).rejects.toThrow('Plugin owner stopped')
	expect(inFlight).toBe(1)
})

it.each([true, false])(
	'keeps native responses and settles empty attempts (managed: %s)',
	async (managed) => {
		await using upstream = createServer((request, response) => {
			response.setHeader('x-upstream', 'native')
			if (request.url === '/no-content') response.writeHead(204).end()
			else if (request.method === 'HEAD') response.writeHead(200).end()
			else response.write('first chunk')
		})
		const origin = 'http://127.0.0.1:' + (await listen(upstream))
		await using host = await createTestHost({ coreConfig: { http: { managed } } })
		const plugin = await host.start(OutboundClient.nodeAddress())
		const fetch = plugin.client().fetch
		using transport = vi.spyOn(globalThis, 'fetch')
		const caller = new AbortController()
		try {
			const empty = await fetch(origin + '/no-content', { signal: caller.signal })
			expect(empty).toMatchObject({ status: 204, url: origin + '/no-content', body: null })
			expect(empty.headers.get('x-upstream')).toBe('native')
			expect(transport.mock.lastCall?.[1]?.signal?.aborted).toBe(true)
			expect(caller.signal.aborted).toBe(false)
			await expect(empty.text()).resolves.toBe('')

			const head = await fetch(origin + '/stream', { method: 'HEAD', signal: caller.signal })
			expect(head).toMatchObject({ status: 200, url: origin + '/stream', body: null })
			expect(transport.mock.lastCall?.[1]?.signal?.aborted).toBe(true)

			const response = await fetch(origin + '/stream', { signal: caller.signal })
			const copy = response.clone()
			expect(copy.url).toBe(origin + '/stream')
			expect(transport.mock.lastCall?.[1]?.signal?.aborted).toBe(false)
			const reading = copy.text().catch((error: unknown) => error)
			caller.abort(new Error('caller cancelled stream'))
			await expect(reading).resolves.toMatchObject({ message: 'caller cancelled stream' })
		} finally {
			upstream.closeAllConnections()
		}
	},
)

it('expires the attempt while waiting for headers and preserves its timeout record', async () => {
	const entered = Promise.withResolvers<void>()
	await using host = await createTestHost({
		coreConfig: {
			http: {
				timeoutMs: 50,
				fetch: async (input) => {
					const { signal } = input as Request
					return await new Promise<Response>((_resolve, reject) => {
						signal.addEventListener('abort', () => reject(signal.reason), { once: true })
						entered.resolve()
					})
				},
			},
		},
	})
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { fetch, root } = plugin.client()
	vi.useFakeTimers()
	try {
		const outcome = fetch('https://service.test').catch((error: unknown) => error)
		await entered.promise
		await vi.advanceTimersByTimeAsync(50)
		await expect(outcome).resolves.toMatchObject({ name: 'TimeoutError' })
		await expect(requireOutboundHttp(root).snapshot(node)).resolves.toMatchObject({
			activity: [{ lastOutcome: 'failed', lastCode: 'timeout' }],
		})
	} finally {
		vi.useRealTimers()
	}
})

it('withdraws a request waiting for the shared policy restore without stopping the restore', async () => {
	const restoreStarted = Promise.withResolvers<void>()
	const restore = Promise.withResolvers<undefined>()
	const terminal = vi.fn(async () => new Response(null, { status: 204 }))
	await using host = await createTestHost({ coreConfig: { http: { fetch: terminal } } })
	const node = OutboundClient.nodeAddress()
	const plugin = await host.start(node)
	const { fetch, root } = plugin.client()
	const storage = requireHostDocuments(root, 'outbound-http')
	const getText = vi.spyOn(storage, 'getText').mockImplementationOnce(() => {
		restoreStarted.resolve()
		return restore.promise
	})
	try {
		const request = fetch('https://example.test').catch((error: unknown) => error)
		await restoreStarted.promise
		await host.stop(node)
		await expect(request).resolves.toMatchObject({ message: 'Plugin owner stopped' })
		expect(terminal).not.toHaveBeenCalled()
		restore.resolve(undefined)
		await expect(requireOutboundHttp(root).snapshot(null)).resolves.toHaveProperty('revision', 0)
		expect(getText).toHaveBeenCalledTimes(1)
	} finally {
		restore.resolve(undefined)
		getText.mockRestore()
	}
})

it('restores scoped policy from Host documents and isolates another Host', async () => {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-outbound-policy-'))
	const zenfs = { mounts: { '/': { backend: Passthrough, fs, prefix } } }
	const fetch = async () => new Response(null, { status: 204 })
	const node = OutboundClient.nodeAddress()
	try {
		{
			await using host = await createTestHost({ coreConfig: { zenfs, http: { fetch } } })
			const plugin = await host.start(node)
			const { root } = plugin.client()
			const policy = requireOutboundHttp(root)
			const defaults = await policy.save(null, 0, { headers: { 'User-Agent': 'saved host' } })
			await defaults.cleanup
			const blocked = await policy.save(node, 1, { allowedOrigins: [] })
			await blocked.cleanup
		}
		await using host = await createTestHost({ coreConfig: { zenfs, http: { fetch } } })
		await using neighbor = await createTestHost({ coreConfig: { http: { fetch } } })
		const plugin = await host.start(node)
		const neighborPlugin = await neighbor.start(node)
		const scoped = plugin.client()
		const separate = neighborPlugin.client()
		await expect(scoped.fetch('https://example.test')).rejects.toMatchObject({
			code: 'origin_denied',
		})
		await expect(separate.fetch('https://example.test')).resolves.toHaveProperty('status', 204)
		expect(await requireOutboundHttp(scoped.root).snapshot(node)).toMatchObject({
			revision: 2,
			settings: { allowedOrigins: [] },
			effective: { headers: { 'user-agent': 'saved host' } },
		})
		await expect(requireOutboundHttp(separate.root).snapshot(node)).resolves.toHaveProperty(
			'revision',
			0,
		)
	} finally {
		await rm(prefix, { recursive: true, force: true })
	}
})

it('keeps the applied policy when a settings write is unconfirmed', async () => {
	const terminal = vi.fn(async () => new Response(null, { status: 204 }))
	await using host = await createTestHost({ coreConfig: { http: { fetch: terminal } } })
	const plugin = await host.start(OutboundClient.nodeAddress())
	const { fetch, root } = plugin.client()
	const policy = requireOutboundHttp(root)
	const restricted = await policy.save(null, 0, { allowedOrigins: ['https://old.test'] })
	await restricted.cleanup
	const storage = requireHostDocuments(root, 'outbound-http')
	const put = vi.spyOn(storage, 'put').mockRejectedValueOnce(new Error('unconfirmed write'))
	try {
		await expect(policy.save(null, 1, { allowedOrigins: ['https://new.test'] })).rejects.toThrow(
			'commit was not confirmed',
		)
		await expect(fetch('https://old.test')).resolves.toHaveProperty('status', 204)
		await expect(fetch('https://new.test')).rejects.toMatchObject({ code: 'origin_denied' })
		await expect(policy.snapshot(null)).resolves.toHaveProperty('revision', 1)
		await expect(policy.save(null, 1, null)).rejects.toThrow('commit was not confirmed')
		expect(put).toHaveBeenCalledTimes(1)
	} finally {
		put.mockRestore()
	}
})

async function listen(server: Server): Promise<number> {
	server.listen(0, '127.0.0.1')
	await once(server, 'listening')
	const address = server.address()
	if (!address || typeof address === 'string') throw new Error('Expected a TCP listener')
	return address.port
}

it('switches a native Node proxy while an admitted request waits to dispatch and read its body', async () => {
	const waitForDispatch = Promise.withResolvers<void>()
	const handoff = Promise.withResolvers<void>()
	const endStream = Promise.withResolvers<void>()
	await using upstream = createServer((request, response) => {
		if (request.url !== '/stream') {
			response.end('new response')
			return
		}
		response.write('old ')
		void endStream.promise.then(() => response.end('response'))
	})
	const destination = await listen(upstream)
	const origin = 'http://127.0.0.1:' + destination
	let forwardedRequests = 0
	await using proxy = createServer((request, response) => {
		const target = new URL(request.url!, origin)
		if (target.origin !== origin) {
			response.writeHead(403).end()
			return
		}
		forwardedRequests++
		const forwardingRequest = requestHttp(target, (reply) => {
			response.writeHead(reply.statusCode!)
			reply.pipe(response)
		})
		response.on('close', () => forwardingRequest.destroy())
		forwardingRequest.on('error', () => response.destroy())
		forwardingRequest.end()
	})
	const proxyUrl = 'http://127.0.0.1:' + (await listen(proxy))
	await using host = await createTestHost({
		coreConfig: {
			http: {
				fetch: async (input, init) => {
					const request = input as Request
					if (new URL(request.url).pathname === '/stream') {
						waitForDispatch.resolve()
						await handoff.promise
					}
					return globalThis.fetch(request, init)
				},
			},
		},
	})
	const plugin = await host.start(OutboundClient.nodeAddress())
	const { fetch, root } = plugin.client()
	const manager = requireOutboundHttp(root)
	const configured = await manager.save(null, 0, { proxyUrl })
	await configured.cleanup
	try {
		const active = fetch(origin + '/stream')
		void active.catch((): void => undefined)
		await waitForDispatch.promise
		const retiring = await manager.save(null, 1, { proxyUrl: null })
		expect(retiring.snapshot.effective.proxyUrl).toBeNull()
		const direct = await fetch(origin)
		await expect(direct.text()).resolves.toBe('new response')
		expect(forwardedRequests).toBe(0)
		handoff.resolve()
		const previous = await active
		expect(forwardedRequests).toBe(1)
		endStream.resolve()
		await expect(previous.text()).resolves.toBe('old response')
		await expect(retiring.cleanup).resolves.toBeUndefined()
	} finally {
		handoff.resolve()
		endStream.resolve()
	}
})
