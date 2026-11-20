import { parsePluginNodeAddress, type PluginConstructor } from '@pluxel/core'
import { createTestHost, type TestHost, type RawPluginConfig } from '@pluxel/test'
import { elysia } from '@pluxel/services/elysia'
import * as v from 'valibot'
import { consumeWorkbenchValue } from '@pluxel/workbench/client'
import { ProxyAgent } from 'undici'
import wretch, { type FetchLike } from 'wretch'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WretchPlugin } from '../src/index.ts'
import { WretchConfig } from '../src/config.ts'
import { createOutboundPolicy } from '../src/outbound-policy.ts'
import {
	ConsumerA,
	ConsumerB,
	ConsumerLateSettings,
	setFixtureFetches,
} from '../src/test-fixtures.ts'
import { openWretchSettings } from './workbench-helpers.ts'
import { ManagedSettingsStore } from '../src/managed-settings.ts'

let fetchA: FetchLike
let fetchB: FetchLike

async function startWretchFixture(
	host: TestHost<boolean>,
	plugins: readonly PluginConstructor[],
	initialConfig?: RawPluginConfig,
): Promise<void> {
	await host.commit((change) => {
		change.catalog.add(plugins)
		if (initialConfig !== undefined) change.config.seed(WretchPlugin.nodeAddress(), initialConfig)
		change.start(plugins.map((plugin) => plugin.nodeAddress()))
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

function gatedSettingsLoad() {
	let reads = 0
	const entered = Promise.withResolvers<void>()
	const gate = Promise.withResolvers<void>()
	const original = ManagedSettingsStore.prototype.load
	const spy = vi.spyOn(ManagedSettingsStore.prototype, 'load').mockImplementation(async function (
		this: ManagedSettingsStore,
		owner,
	) {
		reads++
		entered.resolve()
		await gate.promise
		return original.call(this, owner)
	})
	return {
		entered: entered.promise,
		reads: () => reads,
		release: gate.resolve,
		dispose: () => spy.mockRestore(),
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
	it('keeps settings isolated between callers with the same display name', async () => {
		await using host = await createTestHost({ workbench: true, services: [elysia()] })
		await startWretchFixture(host, [WretchPlugin, ConsumerA, ConsumerLateSettings])
		using first = await openWretchSettings(host, ConsumerA.nodeAddress())
		using second = await openWretchSettings(host, ConsumerLateSettings.nodeAddress())
		await first.api.updateDto({ headers: { 'X-Owner': 'first' } })
		await second.api.updateDto({ headers: { 'X-Owner': 'second' } })
		const firstSnapshot = await first.api.snapshotDto()
		const secondSnapshot = await second.api.snapshotDto()
		expect(firstSnapshot.settings.headers).toEqual({ 'x-owner': 'first' })
		expect(secondSnapshot.settings.headers).toEqual({ 'x-owner': 'second' })
	})

	it('emits portable settings snapshots without undefined optional fields', async () => {
		{
			await using host = await createTestHost({
				workbench: true,
				services: [elysia()],
			})

			await startWretchFixture(host, [WretchPlugin, ConsumerA])
			using settings = await openWretchSettings(host, ConsumerA.nodeAddress())

			const headersOnly = await consumeWorkbenchValue(
				settings.api.updateDto({ headers: { 'X-Mode': 'headers' } }),
			)
			expect(headersOnly.settings).toEqual({ headers: { 'x-mode': 'headers' } })
			expect(Object.hasOwn(headersOnly.settings, 'proxyUrl')).toBe(false)
			expect(Object.hasOwn(headersOnly.settings, 'timeoutMs')).toBe(false)

			const proxyOnly = await consumeWorkbenchValue(
				settings.api.updateDto({ headers: {}, proxyUrl: 'http://proxy.example:8080' }),
			)
			expect(proxyOnly.settings).toEqual({
				headers: {},
				proxyUrl: 'http://proxy.example:8080/',
			})
			expect(Object.hasOwn(proxyOnly.settings, 'timeoutMs')).toBe(false)

			const timeoutOnly = await consumeWorkbenchValue(
				settings.api.updateDto({ headers: {}, timeoutMs: 1_000 }),
			)
			expect(timeoutOnly.settings).toEqual({ headers: {}, timeoutMs: 1_000 })
			expect(Object.hasOwn(timeoutOnly.settings, 'proxyUrl')).toBe(false)

			const queried = consumeWorkbenchValue(await settings.api.snapshotDto())
			expect(queried).toEqual(timeoutOnly)
		}
	})

	it('rejects restored settings whose owner does not match its row ID', async () => {
		await using host = await createTestHost({
			workbench: true,
			services: [elysia()],
		})
		await startWretchFixture(host, [WretchPlugin, ConsumerA, ConsumerLateSettings])
		using settings = await openWretchSettings(host, ConsumerA.nodeAddress())
		await settings.api.updateDto({ headers: {} })
		const tinybase = host.require(WretchPlugin.nodeAddress()).ctx.tinybase
		const store = await tinybase.open()
		const id = store.getRowIds('consumerSettings')[0]!
		store.setCell(
			'consumerSettings',
			id,
			'owner',
			JSON.stringify(ConsumerLateSettings.nodeAddress()),
		)
		await tinybase.flush()
		await host.stop(WretchPlugin.nodeAddress())
		const failure = await host.commitExpectFail((change) => {
			change.start([WretchPlugin.nodeAddress(), ConsumerA.nodeAddress()])
		})
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				plugin: parsePluginNodeAddress(ConsumerA.nodeAddress()),
				kind: 'start-failed',
				message: expect.stringContaining('owner does not match'),
			}),
		)
	})

	it('provides one native immutable Wretch base for independent consumer composition', async () => {
		{
			await using host = await createTestHost()

			await startWretchFixture(host, [WretchPlugin, ConsumerA, ConsumerB])

			const a = await host.require(ConsumerA.nodeAddress()).client.get('/users').json<{
				url: string
				consumer: string
			}>()
			const b = await host
				.require(ConsumerB.nodeAddress())
				.client.post({ ok: true }, '/events')
				.json<{
					url: string
					consumer: string
				}>()

			expect(a).toEqual({ url: 'https://a.example/api/users', consumer: 'a' })
			expect(b).toEqual({ url: 'https://b.example/v1/events', consumer: 'b' })
		}
	})

	it('applies Workbench edits to a cached client and restores them after consumer restart', async () => {
		fetchA = async (url, options) =>
			jsonResponse({
				url,
				language: new Headers(options.headers).get('accept-language'),
				consumer: new Headers(options.headers).get('x-consumer'),
				hasProxyDispatcher: Boolean(options.dispatcher),
			})
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = await createTestHost({
				workbench: true,
				services: [elysia()],
			})

			await startWretchFixture(host, [WretchPlugin, ConsumerLateSettings])
			const consumer = host.require(ConsumerLateSettings.nodeAddress())
			const client = consumer.client
			using settings = await openWretchSettings(host, ConsumerLateSettings.nodeAddress())

			await settings.api.updateDto({
				headers: { 'Accept-Language': 'zh-HK', 'X-Consumer': 'managed' },
				proxyUrl: 'http://proxy.example:8080',
				timeoutMs: 5_000,
			})

			await expect(client.get('/managed').json()).resolves.toMatchObject({
				language: 'zh-HK',
				consumer: 'managed',
				hasProxyDispatcher: true,
			})

			await host.stop(ConsumerLateSettings.nodeAddress())
			await host.start(ConsumerLateSettings.nodeAddress())

			using restarted = await openWretchSettings(host, ConsumerLateSettings.nodeAddress())
			const restartedSnapshot = await restarted.api.snapshotDto()
			expect(restartedSnapshot.settings).toMatchObject({
				headers: { 'accept-language': 'zh-HK', 'x-consumer': 'managed' },
				proxyUrl: 'http://proxy.example:8080/',
				timeoutMs: 5_000,
			})
		}
	})

	it('rejects unsafe proxy, header, and timeout settings', async () => {
		{
			await using host = await createTestHost({
				workbench: true,
				services: [elysia()],
			})

			await startWretchFixture(host, [WretchPlugin, ConsumerA], { timeoutMs: 1_000 })
			using settings = await openWretchSettings(host, ConsumerA.nodeAddress())

			await expect(
				settings.api.updateDto({ headers: {}, proxyUrl: 'http://user:pass@proxy.example' }),
			).rejects.toThrow('Authenticated proxy URLs are not supported')
			await expect(
				settings.api.updateDto({ headers: {}, proxyUrl: 'http://proxy.example/tunnel' }),
			).rejects.toThrow('without path')
			await expect(
				settings.api.updateDto({ headers: { Authorization: 'Bearer secret' } }),
			).rejects.toThrow('secret-bearing')
			await expect(settings.api.updateDto({ headers: {}, timeoutMs: 2_000 })).rejects.toThrow(
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

	it('shares one managed-settings initialization across concurrent calls', async () => {
		await using host = await createTestHost()
		await startWretchFixture(host, [WretchPlugin, ConsumerB])
		const pending = gatedSettingsLoad()
		try {
			const http = host.require(ConsumerB.nodeAddress()).http
			const first = http.enableManagedSettings()
			const second = http.enableManagedSettings()
			await pending.entered
			pending.release()
			await Promise.all([first, second])
			expect(pending.reads()).toBe(1)
			expect(http.managedSettings.settings.headers).toEqual({})
		} finally {
			pending.release()
			pending.dispose()
		}
	})

	it('drains admitted settings initialization without reusing it across generations', async () => {
		await using host = await createTestHost()
		await startWretchFixture(host, [WretchPlugin, ConsumerB])
		const pending = gatedSettingsLoad()
		try {
			const stale = host.require(ConsumerB.nodeAddress()).http.enableManagedSettings()
			await pending.entered
			const restart = host.restart(WretchPlugin.nodeAddress())
			pending.release()
			await restart
			await expect(stale).resolves.toBeUndefined()
			await host.restart(WretchPlugin.nodeAddress())
			await expect(
				host.require(ConsumerB.nodeAddress()).http.enableManagedSettings(),
			).resolves.toBeUndefined()
			expect(pending.reads()).toBe(2)
		} finally {
			pending.release()
			pending.dispose()
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
			await using host = await createTestHost()

			await startWretchFixture(host, [WretchPlugin, ConsumerA], {
				allowedOrigins: ['https://allowed.example'],
			})

			await expect(
				host.require(ConsumerA.nodeAddress()).client.get('/blocked').json(),
			).rejects.toThrow('origin is not allowed')
			expect(called).toBe(false)
		}
	})

	it('bounds concurrent and queued fetch attempts', async () => {
		const firstResponse = Promise.withResolvers<Response>()
		const secondResponse = Promise.withResolvers<Response>()
		const secondStarted = Promise.withResolvers<void>()
		fetchA = vi.fn((url) => {
			if (url.endsWith('/one')) return firstResponse.promise
			secondStarted.resolve()
			return secondResponse.promise
		})
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = await createTestHost()

			await startWretchFixture(host, [WretchPlugin, ConsumerA], {
				maxConcurrentRequests: 1,
				maxQueuedRequests: 1,
			})

			const client = host.require(ConsumerA.nodeAddress()).client
			const first = client.get('/one').json()
			const second = client.get('/two').json()
			const third = client.get('/three').json()
			try {
				await expect(third).rejects.toThrow('queue is full')
				expect(fetchA).toHaveBeenCalledOnce()
				firstResponse.resolve(jsonResponse({ ok: true }))
				await expect(first).resolves.toEqual({ ok: true })
				await secondStarted.promise
				expect(fetchA).toHaveBeenCalledTimes(2)
			} finally {
				firstResponse.resolve(jsonResponse({ ok: true }))
				secondResponse.resolve(jsonResponse({ ok: true }))
			}
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
			await using host = await createTestHost()

			await startWretchFixture(host, [WretchPlugin, ConsumerB])

			const callerClient = host.require(ConsumerB.nodeAddress()).client
			await host.stop(ConsumerB.nodeAddress())
			await expect(
				Promise.resolve().then(() => callerClient.get('/stale-caller').json()),
			).rejects.toThrow('stopped or replaced plugin generation')

			await host.start(ConsumerB.nodeAddress())
			const providerClient = host.require(ConsumerB.nodeAddress()).client
			await host.restart(WretchPlugin.nodeAddress())
			await expect(
				Promise.resolve().then(() => providerClient.get('/stale-provider').json()),
			).rejects.toThrow('stopped or replaced plugin generation')
			await expect(
				host.require(ConsumerB.nodeAddress()).client.get('/current').json(),
			).resolves.toEqual({
				ok: true,
			})
			expect(calls).toBe(1)
		}
	})

	it('closes each settings View independently and revokes open Views when the caller stops', async () => {
		await using host = await createTestHost({ workbench: true, services: [elysia()] })
		await startWretchFixture(host, [WretchPlugin, ConsumerA])

		using settings = await openWretchSettings(host, ConsumerA.nodeAddress())
		using independent = await openWretchSettings(host, ConsumerA.nodeAddress())
		expect(independent.api).not.toBe(settings.api)
		settings[Symbol.dispose]()
		expect(await settledCall(() => settings.api.snapshotDto())).toEqual({ ok: false })
		expect(await settledCall(() => settings.api.updateDto({ headers: {} }))).toEqual({ ok: false })
		const snapshot = await independent.api.snapshotDto()
		expect(snapshot.settings.headers).toEqual({})

		await host.stop(ConsumerA.nodeAddress())
		await expect(independent.api.snapshotDto()).rejects.toThrow(
			'stopped or replaced plugin generation',
		)
		await expect(independent.api.updateDto({ headers: {} })).rejects.toThrow(
			'stopped or replaced plugin generation',
		)
	})

	it('releases managed proxy state on a provider restart', async () => {
		const close = vi.spyOn(ProxyAgent.prototype, 'close')
		try {
			{
				await using host = await createTestHost({
					workbench: true,
					services: [elysia()],
				})

				await startWretchFixture(host, [WretchPlugin, ConsumerA])

				using settings = await openWretchSettings(host, ConsumerA.nodeAddress())
				await settings.api.updateDto({
					headers: {},
					proxyUrl: 'http://proxy.example:8080',
				})
				const before = close.mock.calls.length
				await host.restart(WretchPlugin.nodeAddress())
				expect(close.mock.calls.length).toBeGreaterThan(before)
			}
		} finally {
			close.mockRestore()
		}
	})

	it('rejects queued attempts and aborts in-flight fetches during teardown', async () => {
		const started = Promise.withResolvers<void>()
		fetchA = vi.fn((_url, options) => {
			started.resolve()
			return new Promise<Response>((_resolve, reject) => {
				const signal = options.signal
				if (signal?.aborted) reject(signal.reason)
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
		})
		setFixtureFetches(fetchA, fetchB)

		{
			await using host = await createTestHost()

			await startWretchFixture(host, [WretchPlugin, ConsumerA], {
				maxConcurrentRequests: 1,
				maxQueuedRequests: 1,
			})

			const client = host.require(ConsumerA.nodeAddress()).client
			const first = client
				.get('/active')
				.json()
				.then(
					(): undefined => undefined,
					(error: unknown) => error,
				)
			await started.promise
			const queued = client
				.get('/queued')
				.json()
				.then(
					(): undefined => undefined,
					(error: unknown) => error,
				)

			await host.stop(WretchPlugin.nodeAddress())
			const [activeError, queuedError] = await Promise.all([first, queued])
			expect(activeError).toMatchObject({
				message: expect.stringContaining('stopped or replaced plugin generation'),
			})
			expect(queuedError).toMatchObject({
				message: expect.stringContaining('stopped or replaced plugin generation'),
			})
			expect(fetchA).toHaveBeenCalledOnce()
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
			await using host = await createTestHost()

			await startWretchFixture(host, [WretchPlugin, ConsumerA], { timeoutMs: 5 })

			await expect(
				host.require(ConsumerA.nodeAddress()).client.get('/slow').json(),
			).rejects.toMatchObject({
				name: 'TimeoutError',
			})
		}
	})
})
