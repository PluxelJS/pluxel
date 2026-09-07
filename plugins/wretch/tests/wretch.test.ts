import {
	createMemoryPersistenceBackend,
	pluginNodeAddressOf,
	type PersistenceBackend,
	type PluginConstructor,
	type PluginNodeAddress,
	v,
} from '@pluxel/runtime'
import {
	createRuntimeTestHost,
	type RawPluginConfig,
	type RuntimeTestHost,
} from '@pluxel/runtime/test'
import { detachWorkbenchPortableValue } from '@pluxel/runtime/workbench/client'
import { ProxyAgent } from 'undici'
import wretch, { type FetchLike } from 'wretch'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WretchPlugin } from '../src/index.ts'
import { WretchConfig } from '../src/config.ts'
import { loadManagedSettings } from '../src/managed-settings.ts'
import { createOutboundPolicy } from '../src/outbound-policy.ts'
import {
	ConsumerA,
	ConsumerB,
	ConsumerLateSettings,
	setFixtureFetches,
} from '../src/test-fixtures.ts'
import { openWretchSettings } from './workbench-helpers.ts'

let fetchA: FetchLike
let fetchB: FetchLike

async function startWretchFixture(
	host: RuntimeTestHost,
	plugins: readonly PluginConstructor[],
	initialConfig?: RawPluginConfig,
): Promise<void> {
	await host.commit((change) => {
		change.catalog.add(plugins)
		if (initialConfig !== undefined) change.config.seed(WretchPlugin, initialConfig)
		change.start(plugins)
	})
}

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status })
}

async function settledCall(operation: () => unknown): Promise<{ ok: true } | { ok: false }> {
	try {
		await operation()
		return { ok: true }
	} catch {
		return { ok: false }
	}
}

function gatedSettingsPersistence(): {
	backend: PersistenceBackend
	reads: () => number
	release: () => void
} {
	const memory = createMemoryPersistenceBackend()
	let settingsReads = 0
	let releaseRead!: () => void
	const readGate = new Promise<void>((resolve) => (releaseRead = resolve))
	return {
		reads: () => settingsReads,
		release: () => releaseRead(),
		backend: {
			...memory,
			namespace(name) {
				const namespace = memory.namespace(name)
				if (name !== '@pluxel/wretch') return namespace
				return {
					...namespace,
					getText: async (key) => {
						settingsReads += 1
						await readGate
						return namespace.getText(key)
					},
				}
			},
		},
	}
}

function trackedSettingsPersistence(): {
	backend: PersistenceBackend
	writes: Map<string, string>
	put: (key: string, value: string) => Promise<void>
} {
	const memory = createMemoryPersistenceBackend()
	const writes = new Map<string, string>()
	const namespace = memory.namespace('@pluxel/wretch')
	return {
		writes,
		put: async (key, value) => {
			writes.set(key, value)
			await namespace.put(key, value, { atomic: true })
		},
		backend: {
			...memory,
			namespace(name) {
				const target = memory.namespace(name)
				if (name !== '@pluxel/wretch') return target
				return {
					...target,
					put: async (key, value, options) => {
						if (typeof value === 'string') writes.set(key, value)
						await target.put(key, value, options)
					},
					delete: async (key) => {
						writes.delete(key)
						await target.delete(key)
					},
				}
			},
		},
	}
}

beforeEach(() => {
	fetchA = async (url, options) =>
		jsonResponse({ url, consumer: new Headers(options.headers).get('x-consumer') })
	fetchB = async (url, options) =>
		jsonResponse({ url, consumer: new Headers(options.headers).get('x-consumer') })
	setFixtureFetches(fetchA, fetchB)
})

describe('WretchPlugin', () => {
	it('separates same-display-name consumers by node address and persists the full owner', async () => {
		const persistence = trackedSettingsPersistence()
		{
			await using host = createRuntimeTestHost({
				workbench: { enabled: true },
				persistence: { mode: 'custom', backend: persistence.backend },
			})

			await startWretchFixture(host, [WretchPlugin, ConsumerA, ConsumerLateSettings])
			const a = host.require(ConsumerA)
			const late = host.require(ConsumerLateSettings)
			using aSettings = await openWretchSettings(host, ConsumerA)
			using lateSettings = await openWretchSettings(host, ConsumerLateSettings)
			await aSettings.api.update({ headers: { 'X-Owner': 'a' } })
			await lateSettings.api.update({ headers: { 'X-Owner': 'late' } })

			expect([...persistence.writes.keys()]).toHaveLength(2)
			for (const [key, text] of persistence.writes) {
				expect(key).toMatch(/^consumers\/v3\/[a-f0-9]{64}\.json$/)
				const stored = JSON.parse(text) as Record<string, unknown>
				expect(stored).toMatchObject({
					format: 'pluxel-wretch-managed-settings',
					version: 2,
				})
				expect([a.ctx.pluginInfo.nodeAddress, late.ctx.pluginInfo.nodeAddress]).toContainEqual(
					stored.owner,
				)
			}
		}
	})

	it('emits portable settings snapshots without undefined optional fields', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startWretchFixture(host, [WretchPlugin, ConsumerA])
			using settings = await openWretchSettings(host, ConsumerA)

			const headersOnly = await detachWorkbenchPortableValue(
				settings.api.update({ headers: { 'X-Mode': 'headers' } }),
			)
			expect(headersOnly.settings).toEqual({ headers: { 'x-mode': 'headers' } })
			expect(Object.hasOwn(headersOnly.settings, 'proxyUrl')).toBe(false)
			expect(Object.hasOwn(headersOnly.settings, 'timeoutMs')).toBe(false)

			const proxyOnly = await detachWorkbenchPortableValue(
				settings.api.update({ headers: {}, proxyUrl: 'http://proxy.example:8080' }),
			)
			expect(proxyOnly.settings).toEqual({
				headers: {},
				proxyUrl: 'http://proxy.example:8080/',
			})
			expect(Object.hasOwn(proxyOnly.settings, 'timeoutMs')).toBe(false)

			const timeoutOnly = await detachWorkbenchPortableValue(
				settings.api.update({ headers: {}, timeoutMs: 1_000 }),
			)
			expect(timeoutOnly.settings).toEqual({ headers: {}, timeoutMs: 1_000 })
			expect(Object.hasOwn(timeoutOnly.settings, 'proxyUrl')).toBe(false)

			const queried = detachWorkbenchPortableValue(await settings.api.snapshot())
			expect(queried).toEqual(timeoutOnly)
		}
	})

	it('rejects persisted settings whose owner does not match the hashed filename', async () => {
		const persistence = trackedSettingsPersistence()
		let key = ''
		let expectedOwner!: PluginNodeAddress
		let wrongOwner: unknown
		{
			await using host = createRuntimeTestHost({
				workbench: { enabled: true },
				persistence: { mode: 'custom', backend: persistence.backend },
			})

			await startWretchFixture(host, [WretchPlugin, ConsumerA, ConsumerLateSettings])
			using settings = await openWretchSettings(host, ConsumerA)
			await settings.api.update({ headers: {} })
			key = [...persistence.writes.keys()][0]!
			expectedOwner = host.require(ConsumerA).ctx.pluginInfo.nodeAddress
			wrongOwner = host.require(ConsumerLateSettings).ctx.pluginInfo.nodeAddress
		}
		const stored = JSON.parse(persistence.writes.get(key)!) as Record<string, unknown>
		await persistence.put(key, JSON.stringify({ ...stored, owner: wrongOwner }))
		await expect(
			loadManagedSettings(persistence.backend.namespace('@pluxel/wretch'), key, expectedOwner),
		).rejects.toThrow('owner does not match')
		await persistence.put(key, JSON.stringify({ headers: {} }))
		await expect(
			loadManagedSettings(persistence.backend.namespace('@pluxel/wretch'), key, expectedOwner),
		).rejects.toThrow('unsupported format')
		await persistence.put(key, JSON.stringify({ ...stored, owner: wrongOwner }))

		{
			await using host = createRuntimeTestHost({
				workbench: false,
				persistence: { mode: 'custom', backend: persistence.backend },
			})

			const failure = await host.commitExpectFail((change) => {
				change.catalog.add([WretchPlugin, ConsumerA])
				change.start([WretchPlugin, ConsumerA])
			})
			expect(failure.lifecycleReport.issues).toContainEqual(
				expect.objectContaining({
					plugin: pluginNodeAddressOf(ConsumerA),
					kind: 'start-failed',
					message: expect.stringContaining('owner does not match'),
				}),
			)
		}
	})

	it('provides one native immutable Wretch base for independent consumer composition', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startWretchFixture(host, [WretchPlugin, ConsumerA, ConsumerB])

			const a = await host.require(ConsumerA).client.get('/users').json<{
				url: string
				consumer: string
			}>()
			const b = await host.require(ConsumerB).client.post({ ok: true }, '/events').json<{
				url: string
				consumer: string
			}>()

			expect(a).toEqual({ url: 'https://a.example/api/users', consumer: 'a' })
			expect(b).toEqual({ url: 'https://b.example/v1/events', consumer: 'b' })
			expect(host.require(WretchPlugin).client._url).toBe('')
		}
	})

	it('applies persisted Workbench settings to an existing client without rebuilding it', async () => {
		fetchA = async (url, options) =>
			jsonResponse({
				url,
				language: new Headers(options.headers).get('accept-language'),
				consumer: new Headers(options.headers).get('x-consumer'),
				hasProxyDispatcher: Boolean(options.dispatcher),
			})
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startWretchFixture(host, [WretchPlugin, ConsumerA])
			const consumer = host.require(ConsumerA)
			const client = consumer.client
			using settings = await openWretchSettings(host, ConsumerA)

			await settings.api.update({
				headers: { 'Accept-Language': 'zh-HK', 'X-Consumer': 'managed' },
				proxyUrl: 'http://proxy.example:8080',
				timeoutMs: 5_000,
			})

			await expect(client.get('/managed').json()).resolves.toMatchObject({
				language: 'zh-HK',
				consumer: 'managed',
				hasProxyDispatcher: true,
			})

			await host.stop(ConsumerA)
			await host.start(ConsumerA)

			using restarted = await openWretchSettings(host, ConsumerA)
			const restartedSnapshot = await restarted.api.snapshot()
			expect(restartedSnapshot.settings).toMatchObject({
				headers: { 'accept-language': 'zh-HK', 'x-consumer': 'managed' },
				proxyUrl: 'http://proxy.example:8080/',
				timeoutMs: 5_000,
			})
		}
	})

	it('rejects unsafe proxy, header, and timeout settings', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startWretchFixture(host, [WretchPlugin, ConsumerA], { timeoutMs: 1_000 })
			using settings = await openWretchSettings(host, ConsumerA)

			await expect(
				settings.api.update({ headers: {}, proxyUrl: 'http://user:pass@proxy.example' }),
			).rejects.toThrow('Authenticated proxy URLs are not supported')
			await expect(
				settings.api.update({ headers: {}, proxyUrl: 'http://proxy.example/tunnel' }),
			).rejects.toThrow('without path')
			await expect(
				settings.api.update({ headers: { Authorization: 'Bearer secret' } }),
			).rejects.toThrow('secret-bearing')
			await expect(settings.api.update({ headers: {}, timeoutMs: 2_000 })).rejects.toThrow(
				'cannot exceed the host limit',
			)
		}
	})

	it('accepts only exact HTTP(S) origins in host policy config', () => {
		expect(v.safeParse(WretchConfig, { allowedOrigins: ['https://allowed.example'] }).success).toBe(
			true,
		)
		expect(
			v.safeParse(WretchConfig, { allowedOrigins: ['https://allowed.example/api'] }).success,
		).toBe(false)
		expect(v.safeParse(WretchConfig, { allowedOrigins: ['ftp://allowed.example'] }).success).toBe(
			false,
		)
	})

	it('applies managed settings to a client created before settings are enabled', async () => {
		fetchA = async (_url, options) =>
			jsonResponse({ language: new Headers(options.headers).get('accept-language') })
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startWretchFixture(host, [WretchPlugin, ConsumerLateSettings])

			const consumer = host.require(ConsumerLateSettings)
			using settings = await openWretchSettings(host, ConsumerLateSettings)
			await settings.api.update({
				headers: { 'Accept-Language': 'zh-HK' },
			})

			await expect(consumer.client.get('/managed').json()).resolves.toEqual({
				language: 'zh-HK',
			})
		}
	})

	it('shares one managed-settings initialization across concurrent calls', async () => {
		const persistence = gatedSettingsPersistence()

		{
			await using host = createRuntimeTestHost({
				workbench: { enabled: true },
				persistence: { mode: 'custom', backend: persistence.backend },
			})

			await startWretchFixture(host, [WretchPlugin, ConsumerB])

			const http = host.require(ConsumerB).http
			const first = http.enableManagedSettings()
			const second = http.enableManagedSettings()
			await Promise.resolve()
			expect(persistence.reads()).toBe(1)
			persistence.release()
			await Promise.all([first, second])
			using settings = await openWretchSettings(host, ConsumerB)
			const settingsSnapshot = await settings.api.snapshot()
			expect(settingsSnapshot.settings.headers).toEqual({})
		}
	})

	it('drains admitted settings initialization without reusing it across generations', async () => {
		const persistence = gatedSettingsPersistence()

		{
			await using host = createRuntimeTestHost({
				workbench: false,
				persistence: { mode: 'custom', backend: persistence.backend },
			})

			await startWretchFixture(host, [WretchPlugin, ConsumerB])

			const http = host.require(ConsumerB).http
			const stale = http.enableManagedSettings()
			await waitFor(() => expect(persistence.reads()).toBe(1))
			const restart = host.restart(WretchPlugin)
			persistence.release()
			await restart

			await expect(stale).resolves.toBeUndefined()
			await host.restart(WretchPlugin)
			await expect(host.require(ConsumerB).http.enableManagedSettings()).resolves.toBeUndefined()
			expect(persistence.reads()).toBe(2)
		}
	})

	it('applies the host origin policy after native Wretch composition', async () => {
		let called = false
		fetchA = async () => {
			called = true
			return jsonResponse({ ok: true })
		}
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startWretchFixture(host, [WretchPlugin, ConsumerA], {
				allowedOrigins: ['https://allowed.example'],
			})

			await expect(host.require(ConsumerA).client.get('/blocked').json()).rejects.toThrow(
				'origin is not allowed',
			)
			expect(called).toBe(false)
		}
	})

	it('bounds concurrent and queued fetch attempts', async () => {
		const releases: Array<() => void> = []
		fetchA = () =>
			new Promise((resolve) => {
				releases.push(() => resolve(jsonResponse({ ok: true })))
			})
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startWretchFixture(host, [WretchPlugin, ConsumerA], {
				maxConcurrentRequests: 1,
				maxQueuedRequests: 1,
			})

			const client = host.require(ConsumerA).client
			const first = client.get('/one').json()
			const second = client.get('/two').json()
			const third = client.get('/three').json()
			await expect(third).rejects.toThrow('queue is full')
			expect(releases).toHaveLength(1)
			releases.shift()?.()
			await expect(first).resolves.toEqual({ ok: true })
			await waitFor(() => expect(releases).toHaveLength(1))
			releases.shift()?.()
			await expect(second).resolves.toEqual({ ok: true })
		}
	})

	it('revokes cached clients with caller and provider generations', async () => {
		let calls = 0
		fetchB = async () => {
			calls += 1
			return jsonResponse({ ok: true })
		}
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startWretchFixture(host, [WretchPlugin, ConsumerB])

			const callerClient = host.require(ConsumerB).client
			await host.stop(ConsumerB)
			await expect(
				Promise.resolve().then(() => callerClient.get('/stale-caller').json()),
			).rejects.toThrow('stopped or replaced plugin generation')

			await host.start(ConsumerB)
			const providerClient = host.require(ConsumerB).client
			await host.restart(WretchPlugin)
			await expect(
				Promise.resolve().then(() => providerClient.get('/stale-provider').json()),
			).rejects.toThrow('stopped or replaced plugin generation')
			await expect(host.require(ConsumerB).client.get('/current').json()).resolves.toEqual({
				ok: true,
			})
			expect(calls).toBe(1)
		}
	})

	it('revokes cached managed-settings RPC with its caller generation', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startWretchFixture(host, [WretchPlugin, ConsumerA])

			using settings = await openWretchSettings(host, ConsumerA)
			const commands = settings.api
			await host.stop(ConsumerA)

			await expect(commands.snapshot()).rejects.toThrow('stopped or replaced plugin generation')
			await expect(commands.update({ headers: {} })).rejects.toThrow(
				'stopped or replaced plugin generation',
			)
		}
	})

	it('revokes a settings capability when its View closes', async () => {
		{
			await using host = createRuntimeTestHost({ workbench: { enabled: true } })

			await startWretchFixture(host, [WretchPlugin, ConsumerA])

			const settings = await openWretchSettings(host, ConsumerA)
			const api = settings.api
			using independentSettings = await openWretchSettings(host, ConsumerA)
			expect(independentSettings.api).not.toBe(api)
			settings[Symbol.dispose]()

			expect(await settledCall(() => api.snapshot())).toEqual({ ok: false })
			expect(await settledCall(() => api.update({ headers: {} }))).toEqual({ ok: false })
			const independentSnapshot = await independentSettings.api.snapshot()
			expect(independentSnapshot.settings.headers).toEqual({})
		}
	})

	it('releases managed proxy state on a provider restart', async () => {
		const close = vi.spyOn(ProxyAgent.prototype, 'close')
		try {
			{
				await using host = createRuntimeTestHost({ workbench: { enabled: true } })

				await startWretchFixture(host, [WretchPlugin, ConsumerA])

				using settings = await openWretchSettings(host, ConsumerA)
				await settings.api.update({
					headers: {},
					proxyUrl: 'http://proxy.example:8080',
				})
				const before = close.mock.calls.length
				await host.restart(WretchPlugin)
				expect(close.mock.calls.length).toBeGreaterThan(before)
			}
		} finally {
			close.mockRestore()
		}
	})

	it('rejects queued attempts and aborts in-flight fetches during teardown', async () => {
		let started = 0
		fetchA = async (_url, options) => {
			started += 1
			return new Promise((_resolve, reject) => {
				const signal = options.signal
				if (signal?.aborted) reject(signal.reason)
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
		}
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startWretchFixture(host, [WretchPlugin, ConsumerA], {
				maxConcurrentRequests: 1,
				maxQueuedRequests: 1,
			})

			const client = host.require(ConsumerA).client
			const first = client
				.get('/active')
				.json()
				.then(
					(): undefined => undefined,
					(error: unknown) => error,
				)
			await waitFor(() => expect(started).toBe(1))
			const queued = client
				.get('/queued')
				.json()
				.then(
					(): undefined => undefined,
					(error: unknown) => error,
				)

			await host.stop(WretchPlugin)
			const [activeError, queuedError] = await Promise.all([first, queued])
			expect(activeError).toMatchObject({
				message: expect.stringContaining('stopped or replaced plugin generation'),
			})
			expect(queuedError).toMatchObject({
				message: expect.stringContaining('stopped or replaced plugin generation'),
			})
			expect(started).toBe(1)
		}
	})

	it('does not enter fetch when policy disposal wins the admission continuation race', async () => {
		let started = 0
		const policy = createOutboundPolicy({
			timeoutMs: 0,
			maxConcurrentRequests: 1,
			maxQueuedRequests: 1,
			allowedOrigins: [],
		})
		const pending = wretch('https://policy.example')
			.middlewares([policy.middleware()])
			.fetchPolyfill(async () => {
				started += 1
				return jsonResponse({ ok: true })
			})
			.get('/race')
			.res()
		policy.dispose()

		await expect(pending).rejects.toThrow('stopped or replaced plugin generation')
		expect(started).toBe(0)
	})

	it('applies the host timeout to a custom fetch boundary', async () => {
		fetchA = async (_url, options) =>
			new Promise((_resolve, reject) => {
				const signal = options.signal
				if (signal?.aborted) reject(signal.reason)
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = createRuntimeTestHost({ workbench: false })

			await startWretchFixture(host, [WretchPlugin, ConsumerA], { timeoutMs: 5 })

			await expect(host.require(ConsumerA).client.get('/slow').json()).rejects.toMatchObject({
				name: 'TimeoutError',
			})
		}
	})
})

async function waitFor(assertion: () => void): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt += 1) {
		try {
			assertion()
			return
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 0))
		}
	}
	assertion()
}
