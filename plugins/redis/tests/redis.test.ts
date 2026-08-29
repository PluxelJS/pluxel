import {
	formatPluginNodeReference,
	pluginDefinitionAddressOf,
	type PluginConstructor,
	v,
} from '@pluxel/runtime'
import { BasePlugin, Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => {
	const makeClient = () => {
		const state = { open: false, ready: false }
		const client = {
			get isOpen() {
				return state.open
			},
			get isReady() {
				return state.ready
			},
			on: vi.fn(),
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
		}
		client.on.mockImplementation(() => client)
		return { state, client }
	}
	const { state, client } = makeClient()
	const createClient = vi.fn(() => client)
	return { state, client, createClient, makeClient }
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
	redisMock.createClient.mockClear()
	redisMock.client.on.mockClear()
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
})

describe('@pluxel/redis', () => {
	it('provides bounded client defaults and revokes the capability on stop', async () => {
		await withRuntimeHost(async (host) => {
			addStarted(host, [RedisPlugin, RedisConsumer])
			await host.commit()

			const consumer = host.require(RedisConsumer)
			expect(consumer.redis.client).toBe(redisMock.client)
			expect(redisMock.createClient).toHaveBeenCalledWith(
				expect.objectContaining({
					url: 'redis://127.0.0.1:6379',
					database: 0,
					name: `pluxel:${formatPluginNodeReference(
						host.require(RedisPlugin).ctx.pluginInfo.nodeAddress,
					)}`,
					commandsQueueMaxLength: 10_000,
					disableOfflineQueue: true,
				}),
			)

			const handle = consumer.redis
			host.stop(RedisPlugin)
			await host.commit()
			expect(redisMock.client.close).toHaveBeenCalledOnce()
			expect(() => handle.client).toThrow('Plugin owner stopped')
		})
	})

	it('rejects credentials and database paths in ordinary plugin config', () => {
		expect(v.safeParse(RedisConfig, { url: 'redis://user:secret@localhost:6379' }).success).toBe(
			false,
		)
		expect(v.safeParse(RedisConfig, { url: 'redis://localhost:6379/2' }).success).toBe(false)
		expect(v.safeParse(RedisConfig, { url: 'rediss://redis.example.com:6380' }).success).toBe(true)
	})

	it('isolates config, clients, and lifecycle across two forks of one provider', async () => {
		const east = redisMock.makeClient()
		const west = redisMock.makeClient()
		redisMock.createClient
			.mockImplementationOnce(() => east.client)
			.mockImplementationOnce(() => west.client)

		await withRuntimeHost(async (host) => {
			host.add([RedisPlugin, RedisConsumerA, RedisConsumerB])
			const East = host.fork(RedisPlugin, 'east')
			const West = host.fork(RedisPlugin, 'west')
			host.cfg(East).set({ url: 'redis://east.example:6379', database: 1 })
			host.cfg(West).set({ url: 'redis://west.example:6379', database: 2 })
			host.start(East)
			host.start(West)
			host.start(RedisConsumerA)
			host.start(RedisConsumerB)
			host.override(RedisConsumerA, pluginDefinitionAddressOf(Redis), East)
			host.override(RedisConsumerB, pluginDefinitionAddressOf(Redis), West)

			await host.commit()
			const eastCapability = host.require(RedisConsumerA).redis
			const westCapability = host.require(RedisConsumerB).redis
			expect(eastCapability.client).toBe(east.client)
			expect(westCapability.client).toBe(west.client)
			expect(redisMock.createClient.mock.calls).toEqual([
				[expect.objectContaining({ url: 'redis://east.example:6379', database: 1 })],
				[expect.objectContaining({ url: 'redis://west.example:6379', database: 2 })],
			])
			expect(host.require(East).ctx).not.toBe(host.require(West).ctx)

			host.stop(East)
			await host.commitAllowFail()
			expect(east.client.close).toHaveBeenCalledOnce()
			expect(() => eastCapability.client).toThrow('Plugin owner stopped')
			expect(west.client.close).not.toHaveBeenCalled()
			expect(westCapability.client).toBe(west.client)
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
