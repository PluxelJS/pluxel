import {
	formatPluginNodeReference,
	pluginNodeAddressOf,
	type PluginConstructor,
	v,
} from '@pluxel/runtime'
import { requireWorkbench } from '@pluxel/runtime/internal'
import { BasePlugin, Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
import type { WorkbenchContentObserver } from '@pluxel/runtime/workbench/client'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => {
	type Listener = (...arguments_: unknown[]) => void
	const makeClient = () => {
		const state = { open: false, ready: false }
		const listeners = new Map<string, Set<Listener>>()
		const client = {
			get isOpen() {
				return state.open
			},
			get isReady() {
				return state.ready
			},
			on: vi.fn(),
			off: vi.fn(),
			connect: vi.fn(async () => {
				state.open = true
				state.ready = true
				return client
			}),
			close: vi.fn(async () => {
				state.open = false
				state.ready = false
			}),
			destroy: vi.fn(() => {
				state.open = false
				state.ready = false
			}),
			ping: vi.fn(async (payload?: string) => payload || 'PONG'),
		}
		client.on.mockImplementation((event: string, listener: Listener) => {
			let eventListeners = listeners.get(event)
			if (!eventListeners) {
				eventListeners = new Set()
				listeners.set(event, eventListeners)
			}
			eventListeners.add(listener)
			return client
		})
		client.off.mockImplementation((event: string, listener: Listener) => {
			listeners.get(event)?.delete(listener)
			return client
		})
		const emit = (event: string, ...arguments_: unknown[]): void => {
			for (const listener of listeners.get(event) ?? []) listener(...arguments_)
		}
		return { state, client, listeners, emit }
	}
	const { state, client, listeners, emit } = makeClient()
	const createClient = vi.fn(() => client)
	return { state, client, listeners, emit, createClient, makeClient }
})

vi.mock('redis', () => ({ createClient: redisMock.createClient }))

import { Redis, RedisConfig, RedisConnectionError, RedisPlugin } from '../src/index.ts'

@Plugin()
class RedisConsumer extends BasePlugin {
	constructor(readonly redis: Redis) {
		super()
	}
}

@Plugin()
class RedisConsumerA extends BasePlugin {
	constructor(readonly redis: Redis) {
		super()
	}
}

@Plugin()
class RedisConsumerB extends BasePlugin {
	constructor(readonly redis: Redis) {
		super()
	}
}

function addStarted(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.start(PluginClass)
}

beforeEach(() => {
	redisMock.state.open = false
	redisMock.state.ready = false
	redisMock.listeners.clear()
	redisMock.createClient.mockClear()
	redisMock.client.on.mockClear()
	redisMock.client.off.mockClear()
	redisMock.client.connect.mockReset().mockImplementation(async () => {
		redisMock.state.open = true
		redisMock.state.ready = true
		return redisMock.client
	})
	redisMock.client.close.mockReset().mockImplementation(async () => {
		redisMock.state.open = false
		redisMock.state.ready = false
	})
	redisMock.client.destroy.mockReset().mockImplementation(() => {
		redisMock.state.open = false
		redisMock.state.ready = false
	})
	redisMock.client.ping
		.mockReset()
		.mockImplementation(async (payload?: string) => payload || 'PONG')
})

describe('@pluxel/redis', () => {
	it('provides bounded client defaults and revokes the capability on stop', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [RedisPlugin, RedisConsumer])
				await host.commit()

				const consumer = host.require(RedisConsumer)
				const handle = consumer.redis.connection()
				expect(handle.client).toBe(redisMock.client)
				expect(redisMock.createClient).toHaveBeenCalledWith(
					expect.objectContaining({
						url: 'redis://127.0.0.1:6379',
						database: 0,
						name: `pluxel:${formatPluginNodeReference(
							host.require(RedisPlugin).ctx.pluginInfo.nodeAddress,
						)}:default`,
						commandsQueueMaxLength: 10_000,
						disableOfflineQueue: true,
					}),
				)
				expect(redisMock.client.on).toHaveBeenCalledTimes(1)
				expect(redisMock.client.on).toHaveBeenCalledWith('error', expect.any(Function))

				host.stop(RedisPlugin)
				await host.commit()
				expect(redisMock.client.close).toHaveBeenCalledOnce()
				expect(() => handle.client).toThrow('Plugin owner stopped')
			},
			{ workbench: false },
		)
	})

	it('publishes live connection state and a bounded transient PING form', async () => {
		await withRuntimeHost(
			async (host) => {
				addStarted(host, [RedisPlugin])
				await host.commit()

				const backend = requireWorkbench(host.ctx)
				const target = pluginNodeAddressOf(RedisPlugin)
				const layout = backend.registry.getLayout(target)
				const entry = layout.entries.find(
					(candidate) =>
						candidate.descriptor.kind === 'content' && candidate.descriptor.key === 'connections',
				)
				if (!entry) throw new Error('RedisPlugin published no connections Content')
				const session = backend.createSession({ provider: 'local', subject: 'operator' }, () => {})
				const opened = await session.target.openEntry({
					layoutRevision: layout.revision,
					target,
					descriptor: entry.descriptor,
				})
				if (!opened.ok || opened.value.kind !== 'content' || opened.value.mode !== 'interactive') {
					throw new Error('Redis connection Content failed to open')
				}

				const updates: unknown[] = []
				const observer = Object.assign(
					(outcome: unknown) =>
						Object.assign(
							Promise.resolve().then(() => updates.push(outcome)),
							{
								[Symbol.dispose]: vi.fn(),
							},
						),
					{
						dup: () => observer,
						[Symbol.dispose]: vi.fn(),
					},
				) as unknown as WorkbenchContentObserver
				await expect(opened.value.root.subscribe(observer)).resolves.toMatchObject({
					ok: true,
					data: {
						status: {
							connections: [
								{
									id: 'default',
									connection: 'ready',
									recentErrorType: null,
									ping: { state: 'not-run' },
								},
							],
						},
					},
				})
				await expect(
					opened.value.root.run('ping', { connectionId: 'default', payload: 'workbench' }),
				).resolves.toMatchObject({
					action: { ok: true, message: expect.stringContaining('replied in') },
					data: {
						ok: true,
						data: { status: { connections: [{ ping: { state: 'succeeded' } }] } },
					},
				})
				expect(redisMock.client.ping).toHaveBeenCalledWith('workbench')
				await expect(
					opened.value.root.run('ping', {
						connectionId: 'default',
						payload: 'x'.repeat(257),
					}),
				).resolves.toMatchObject({
					action: { ok: false, code: 'validation_failed' },
					data: null,
				})
				expect(redisMock.client.ping).toHaveBeenCalledTimes(1)

				redisMock.state.ready = false
				redisMock.emit('reconnecting')
				await vi.waitFor(() =>
					expect(updates).toContainEqual(
						expect.objectContaining({
							data: expect.objectContaining({
								status: expect.objectContaining({
									connections: [expect.objectContaining({ connection: 'reconnecting' })],
								}),
							}),
						}),
					),
				)
				session.dispose()
			},
			{ workbench: { enabled: true } },
		)
	})

	it('rejects credentials and database paths in ordinary plugin config', () => {
		expect(
			v.safeParse(RedisConfig, {
				connections: [{ id: 'default', url: 'redis://user:secret@localhost:6379' }],
			}).success,
		).toBe(false)
		expect(
			v.safeParse(RedisConfig, {
				connections: [{ id: 'default', url: 'redis://localhost:6379/2' }],
			}).success,
		).toBe(false)
		expect(
			v.safeParse(RedisConfig, {
				connections: [{ id: 'default', url: 'rediss://redis.example.com:6380' }],
			}).success,
		).toBe(true)
		expect(
			v.safeParse(RedisConfig, {
				connections: [{ id: 'cache' }, { id: 'cache' }],
			}).success,
		).toBe(false)
	})

	it('provides O(1) named connection selection and owner-bound handles', async () => {
		const east = redisMock.makeClient()
		const west = redisMock.makeClient()
		redisMock.createClient
			.mockImplementationOnce(() => east.client)
			.mockImplementationOnce(() => west.client)

		await withRuntimeHost(async (host) => {
			addStarted(host, [RedisPlugin, RedisConsumerA, RedisConsumerB])
			host.cfg(RedisPlugin).set({
				connections: [
					{ id: 'east', url: 'redis://east.example:6379', database: 1 },
					{ id: 'west', url: 'redis://west.example:6379', database: 2 },
				],
			})

			await host.commit()
			const eastConnection = host.require(RedisConsumerA).redis.connection('east')
			const westConnection = host.require(RedisConsumerB).redis.connection('west')
			expect(eastConnection.client).toBe(east.client)
			expect(westConnection.client).toBe(west.client)
			expect(host.require(RedisConsumerA).redis.connection('east')).toBe(eastConnection)
			expect(host.require(RedisConsumerA).redis.connectionIds()).toEqual(['east', 'west'])
			expect(() => host.require(RedisConsumerA).redis.connection('missing')).toThrowError(
				expect.objectContaining({ code: 'REDIS_CONNECTION_NOT_FOUND' }),
			)
			expect(redisMock.createClient.mock.calls).toEqual([
				[expect.objectContaining({ url: 'redis://east.example:6379', database: 1 })],
				[expect.objectContaining({ url: 'redis://west.example:6379', database: 2 })],
			])
			host.stop(RedisConsumerA)
			await host.commit()
			expect(east.client.close).not.toHaveBeenCalled()
			expect(() => eastConnection.client).toThrow('Plugin owner stopped')
			expect(west.client.close).not.toHaveBeenCalled()
			expect(westConnection.client).toBe(west.client)
		})
	})

	it('fails lifecycle honestly and destroys a client that cannot connect', async () => {
		redisMock.client.connect.mockRejectedValueOnce(new Error('offline'))

		await withRuntimeHost(async (host) => {
			addStarted(host, [RedisPlugin])
			const commit = await host.commitAllowFail()
			expect(host.isRunning(RedisPlugin)).toBe(false)
			expect(redisMock.client.destroy).toHaveBeenCalledOnce()
			expect(
				commit.lifecycleReport.issues.some(
					(issue) => issue.error?.name === RedisConnectionError.name,
				),
			).toBe(true)
		})
	})
})
