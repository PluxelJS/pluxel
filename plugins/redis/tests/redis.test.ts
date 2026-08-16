import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { formatPluginNodeAddress, v } from '@pluxel/runtime'

const redisMock = vi.hoisted(() => {
	const state = { open: false, ready: false }
	const client = {
		get isOpen() {
			return state.open
		},
		get isReady() {
			return state.ready
		},
		on: vi.fn(),
		connect: vi.fn(),
		close: vi.fn(),
		destroy: vi.fn(),
	}
	client.on.mockImplementation(() => client)
	const createClient = vi.fn(() => client)
	return { state, client, createClient }
})

vi.mock('redis', () => ({ createClient: redisMock.createClient }))

import {
	Redis,
	RedisConfig,
	RedisConnectionError,
	RedisNotRunningError,
	RedisPlugin,
} from '../src/index.ts'

@Plugin()
class RedisConsumer extends BasePlugin {
	constructor(readonly redis: Redis) {
		super()
	}
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
		await withHost(async (host) => {
			host.add([RedisPlugin, RedisConsumer])
			await host.commit()

			const consumer = host.require(RedisConsumer)
			expect(consumer.redis.client).toBe(redisMock.client)
			expect(redisMock.createClient).toHaveBeenCalledWith(
				expect.objectContaining({
					url: 'redis://127.0.0.1:6379',
					database: 0,
					name: `pluxel:${formatPluginNodeAddress(
						host.require(RedisPlugin).ctx.pluginInfo.nodeAddress,
					)}`,
					commandsQueueMaxLength: 10_000,
					disableOfflineQueue: true,
				}),
			)

			const handle = consumer.redis
			host.remove(RedisPlugin)
			await host.commit()
			expect(redisMock.client.close).toHaveBeenCalledOnce()
			expect(() => handle.client).toThrow(RedisNotRunningError)
		})
	})

	it('rejects credentials and database paths in ordinary plugin config', () => {
		expect(v.safeParse(RedisConfig, { url: 'redis://user:secret@localhost:6379' }).success).toBe(
			false,
		)
		expect(v.safeParse(RedisConfig, { url: 'redis://localhost:6379/2' }).success).toBe(false)
		expect(v.safeParse(RedisConfig, { url: 'rediss://redis.example.com:6380' }).success).toBe(true)
	})

	it('fails lifecycle honestly and destroys a client that cannot connect', async () => {
		redisMock.client.connect.mockRejectedValueOnce(new Error('offline'))

		await withHost(async (host) => {
			host.add(RedisPlugin)
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
