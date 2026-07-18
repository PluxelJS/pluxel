import { v } from '@pluxel/runtime'
import { withRuntimeHost } from '@pluxel/runtime/test'
import type { WorkbenchLayout } from '@pluxel/runtime/workbench'
import {
	RUNTIME_INTERNAL_API_BASE,
	RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE,
} from '@pluxel/runtime/web/paths'
import type { FetchLike } from 'wretch'
import { retry } from 'wretch/middlewares'
import { beforeEach, describe, expect, it } from 'vitest'
import { WretchPlugin } from '../src/index.ts'
import { WretchConfig } from '../src/config.ts'
import {
	ConsumerA,
	ConsumerB,
	ConsumerLateSettings,
	setFixtureFetches,
} from '../src/test-fixtures.ts'

let fetchA: FetchLike
let fetchB: FetchLike

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status })
}

beforeEach(() => {
	fetchA = async (url, options) =>
		jsonResponse({ url, consumer: new Headers(options.headers).get('x-consumer') })
	fetchB = async (url, options) =>
		jsonResponse({ url, consumer: new Headers(options.headers).get('x-consumer') })
	setFixtureFetches(fetchA, fetchB)
})

describe('WretchPlugin', () => {
	it('connects the provider renderer to the opted-in consumer through a target-scoped Port', async () => {
		await withRuntimeHost(async (host) => {
			host.add([WretchPlugin, ConsumerA])
			host.cfg(WretchPlugin).enable()
			await host.commit()

			expect(host.isRunning(WretchPlugin)).toBe(true)
			expect(host.isRunning(ConsumerA)).toBe(true)

			const response = await host.ctx.http.fetch(
				new Request(
					`http://local.test${RUNTIME_INTERNAL_API_BASE}${RUNTIME_WORKBENCH_PLUGIN_LAYOUT_BASE}/WretchConsumerA`,
				),
			)
			expect(response.status).toBe(200)
			const layout = (await response.json()) as WorkbenchLayout
			expect(layout.items).toEqual([
				expect.objectContaining({
					ownerPluginId: 'WretchPlugin',
					targetPluginId: 'WretchConsumerA',
					viewId: 'HttpSettings',
					port: expect.objectContaining({
						id: '@pluxel/wretch.settings',
						model: { settings: expect.objectContaining({ kind: 'rpc' }) },
					}),
				}),
			])
		})
	})

	it('provides one native immutable Wretch base for independent consumer composition', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA, ConsumerB])
				host.cfg(WretchPlugin).enable()
				await host.commit()

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
			},
			{ workbench: false },
		)
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

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).enable()
				await host.commit()
				const consumer = host.require(ConsumerA)
				const client = consumer.client
				const commands = consumer.http.workbenchSettings()

				await commands.update({
					headers: { 'Accept-Language': 'zh-HK', 'X-Consumer': 'managed' },
					proxyUrl: 'http://proxy.example:8080',
					timeoutMs: 5_000,
				})

				await expect(client.get('/managed').json()).resolves.toMatchObject({
					language: 'zh-HK',
					consumer: 'managed',
					hasProxyDispatcher: true,
				})

				host.remove(ConsumerA)
				await host.commit()
				host.add(ConsumerA)
				await host.commit()

				expect(host.require(ConsumerA).http.workbenchSettings().get().settings).toMatchObject({
					headers: { 'accept-language': 'zh-HK', 'x-consumer': 'managed' },
					proxyUrl: 'http://proxy.example:8080/',
					timeoutMs: 5_000,
				})
			},
			{ workbench: false },
		)
	})

	it('rejects proxy URLs with credentials or path components', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).enable()
				await host.commit()
				const commands = host.require(ConsumerA).http.workbenchSettings()

				await expect(
					commands.update({ headers: {}, proxyUrl: 'http://user:pass@proxy.example' }),
				).rejects.toThrow('Authenticated proxy URLs are not supported')
				await expect(
					commands.update({ headers: {}, proxyUrl: 'http://proxy.example/tunnel' }),
				).rejects.toThrow('without path')
			},
			{ workbench: false },
		)
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

	it('rejects secret-bearing Workbench headers', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).enable()
				await host.commit()

				await expect(
					host
						.require(ConsumerA)
						.http.workbenchSettings()
						.update({
							headers: { Authorization: 'Bearer secret' },
						}),
				).rejects.toThrow('secret-bearing')
			},
			{ workbench: false },
		)
	})

	it('applies managed settings to a client created before settings are enabled', async () => {
		fetchA = async (_url, options) =>
			jsonResponse({ language: new Headers(options.headers).get('accept-language') })
		setFixtureFetches(fetchA, fetchB)

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerLateSettings])
				host.cfg(WretchPlugin).enable()
				await host.commit()

				const consumer = host.require(ConsumerLateSettings)
				await consumer.http.workbenchSettings().update({
					headers: { 'Accept-Language': 'zh-HK' },
				})

				await expect(consumer.client.get('/managed').json()).resolves.toEqual({
					language: 'zh-HK',
				})
			},
			{ workbench: false },
		)
	})

	it('rejects a consumer timeout above the host limit', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).set({ config: { timeoutMs: 1_000 } })
				host.cfg(WretchPlugin).enable()
				await host.commit()

				await expect(
					host.require(ConsumerA).http.workbenchSettings().update({
						headers: {},
						timeoutMs: 2_000,
					}),
				).rejects.toThrow('cannot exceed the host limit')
			},
			{ workbench: false },
		)
	})

	it('applies the host origin policy after native Wretch composition', async () => {
		let called = false
		fetchA = async () => {
			called = true
			return jsonResponse({ ok: true })
		}
		setFixtureFetches(fetchA, fetchB)

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).set({ config: { allowedOrigins: ['https://allowed.example'] } })
				host.cfg(WretchPlugin).enable()
				await host.commit()

				await expect(host.require(ConsumerA).client.get('/blocked').json()).rejects.toThrow(
					'origin is not allowed',
				)
				expect(called).toBe(false)
			},
			{ workbench: false },
		)
	})

	it('keeps retry as an explicit native Wretch middleware', async () => {
		let attempts = 0
		fetchA = async () => {
			attempts += 1
			return attempts === 1 ? jsonResponse({ ok: false }, 503) : jsonResponse({ ok: true })
		}
		setFixtureFetches(fetchA, fetchB)

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).enable()
				await host.commit()

				const client = host
					.require(ConsumerA)
					.client.middlewares([retry({ maxAttempts: 1, delayTimer: 0 })])
				await expect(client.get('/retry').json()).resolves.toEqual({ ok: true })
				expect(attempts).toBe(2)
			},
			{ workbench: false },
		)
	})

	it('bounds concurrent and queued fetch attempts', async () => {
		const releases: Array<() => void> = []
		fetchA = () =>
			new Promise((resolve) => {
				releases.push(() => resolve(jsonResponse({ ok: true })))
			})
		setFixtureFetches(fetchA, fetchB)

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).set({ config: { maxConcurrentRequests: 1, maxQueuedRequests: 1 } })
				host.cfg(WretchPlugin).enable()
				await host.commit()

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
			},
			{ workbench: false },
		)
	})

	it('applies the host timeout to a custom fetch boundary', async () => {
		fetchA = async (_url, options) =>
			new Promise((_resolve, reject) => {
				const signal = options.signal
				if (signal?.aborted) reject(signal.reason)
				else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
			})
		setFixtureFetches(fetchA, fetchB)

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).set({ config: { timeoutMs: 5 } })
				host.cfg(WretchPlugin).enable()
				await host.commit()

				await expect(host.require(ConsumerA).client.get('/slow').json()).rejects.toMatchObject({
					name: 'TimeoutError',
				})
			},
			{ workbench: false },
		)
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
