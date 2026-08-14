import { createMemoryPersistenceBackend, type PersistenceBackend, v } from '@pluxel/runtime'
import { withRuntimeHost } from '@pluxel/runtime/test'
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

let fetchA: FetchLike
let fetchB: FetchLike

function jsonResponse(value: unknown, status = 200): Response {
	return Response.json(value, { status })
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

beforeEach(() => {
	fetchA = async (url, options) =>
		jsonResponse({ url, consumer: new Headers(options.headers).get('x-consumer') })
	fetchB = async (url, options) =>
		jsonResponse({ url, consumer: new Headers(options.headers).get('x-consumer') })
	setFixtureFetches(fetchA, fetchB)
})

describe('WretchPlugin', () => {
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

	it('rejects unsafe proxy, header, and timeout settings', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).set({ config: { timeoutMs: 1_000 } })
				host.cfg(WretchPlugin).enable()
				await host.commit()
				const commands = host.require(ConsumerA).http.workbenchSettings()

				await expect(
					commands.update({ headers: {}, proxyUrl: 'http://user:pass@proxy.example' }),
				).rejects.toThrow('Authenticated proxy URLs are not supported')
				await expect(
					commands.update({ headers: {}, proxyUrl: 'http://proxy.example/tunnel' }),
				).rejects.toThrow('without path')
				await expect(
					commands.update({ headers: { Authorization: 'Bearer secret' } }),
				).rejects.toThrow('secret-bearing')
				await expect(commands.update({ headers: {}, timeoutMs: 2_000 })).rejects.toThrow(
					'cannot exceed the host limit',
				)
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

	it('shares one managed-settings initialization across concurrent calls', async () => {
		const persistence = gatedSettingsPersistence()

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerB])
				host.cfg(WretchPlugin).enable()
				await host.commit()

				const http = host.require(ConsumerB).http
				const first = http.enableManagedSettings()
				const second = http.enableManagedSettings()
				await Promise.resolve()
				expect(persistence.reads()).toBe(1)
				persistence.release()
				await Promise.all([first, second])
				expect(http.workbenchSettings().get().settings.headers).toEqual({})
			},
			{ workbench: false, persistence: { mode: 'custom', backend: persistence.backend } },
		)
	})

	it('does not publish managed settings loaded by a replaced provider generation', async () => {
		const persistence = gatedSettingsPersistence()

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerB])
				host.cfg(WretchPlugin).enable()
				await host.commit()

				const http = host.require(ConsumerB).http
				const stale = http.enableManagedSettings()
				await waitFor(() => expect(persistence.reads()).toBe(1))
				host.restart(WretchPlugin, { cascadeDependents: false })
				await host.commit()
				persistence.release()

				await expect(stale).rejects.toThrow('stopped or replaced plugin generation')
				host.restart(WretchPlugin, { cascadeDependents: true })
				await host.commit()
				await expect(host.require(ConsumerB).http.enableManagedSettings()).resolves.toBeUndefined()
				expect(persistence.reads()).toBe(2)
			},
			{ workbench: false, persistence: { mode: 'custom', backend: persistence.backend } },
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

	it('revokes cached clients with caller and provider generations', async () => {
		let calls = 0
		fetchB = async () => {
			calls += 1
			return jsonResponse({ ok: true })
		}
		setFixtureFetches(fetchA, fetchB)

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerB])
				host.cfg(WretchPlugin).enable()
				await host.commit()

				const callerClient = host.require(ConsumerB).client
				host.remove(ConsumerB)
				await host.commit()
				await expect(callerClient.get('/stale-caller').json()).rejects.toThrow(
					'stopped or replaced plugin generation',
				)

				host.add(ConsumerB)
				await host.commit()
				const providerClient = host.require(ConsumerB).client
				host.restart(WretchPlugin, { cascadeDependents: true })
				await host.commit()
				await expect(providerClient.get('/stale-provider').json()).rejects.toThrow(
					'stopped or replaced plugin generation',
				)
				await expect(host.require(ConsumerB).client.get('/current').json()).resolves.toEqual({
					ok: true,
				})
				expect(calls).toBe(1)
			},
			{ workbench: false },
		)
	})

	it('revokes cached managed-settings RPC with its caller generation', async () => {
		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).enable()
				await host.commit()

				const commands = host.require(ConsumerA).http.workbenchSettings()
				host.remove(ConsumerA)
				await host.commit()

				expect(() => commands.get()).toThrow('stopped or replaced plugin generation')
				await expect(commands.update({ headers: {} })).rejects.toThrow(
					'stopped or replaced plugin generation',
				)
			},
			{ workbench: false },
		)
	})

	it('releases managed proxy state on a non-cascade provider restart', async () => {
		const close = vi.spyOn(ProxyAgent.prototype, 'close')
		try {
			await withRuntimeHost(
				async (host) => {
					host.add([WretchPlugin, ConsumerA])
					host.cfg(WretchPlugin).enable()
					await host.commit()

					await host.require(ConsumerA).http.workbenchSettings().update({
						headers: {},
						proxyUrl: 'http://proxy.example:8080',
					})
					const before = close.mock.calls.length
					host.restart(WretchPlugin, { cascadeDependents: false })
					await host.commit()
					expect(close.mock.calls.length).toBeGreaterThan(before)
				},
				{ workbench: false },
			)
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

		await withRuntimeHost(
			async (host) => {
				host.add([WretchPlugin, ConsumerA])
				host.cfg(WretchPlugin).set({ config: { maxConcurrentRequests: 1, maxQueuedRequests: 1 } })
				host.cfg(WretchPlugin).enable()
				await host.commit()

				const client = host.require(ConsumerA).client
				const first = client
					.get('/active')
					.json()
					.then(
						() => undefined,
						(error: unknown) => error,
					)
				await waitFor(() => expect(started).toBe(1))
				const queued = client
					.get('/queued')
					.json()
					.then(
						() => undefined,
						(error: unknown) => error,
					)

				host.remove(WretchPlugin)
				await host.commit()
				const [activeError, queuedError] = await Promise.all([first, queued])
				expect(activeError).toMatchObject({
					message: expect.stringContaining('stopped or replaced plugin generation'),
				})
				expect(queuedError).toMatchObject({
					message: expect.stringContaining('stopped or replaced plugin generation'),
				})
				expect(started).toBe(1)
			},
			{ workbench: false },
		)
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
