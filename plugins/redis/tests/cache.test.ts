import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { v } from '@pluxel/runtime'
import { BasePlugin, getPluginInfo, Plugin, withHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import {
	Redis,
	RedisCacheBackendConfig,
	RedisCacheBackendPlugin,
	type RedisClient,
} from '../src/index.ts'

type FakeSetOptions = { expiration?: { type: 'PX'; value: number } }

class FakeRedisClient {
	readonly values = new Map<string, string>()
	readonly ttls = new Map<string, number>()
	readonly evalShaCalls: Array<{ sha1: string; keys: string[] }> = []
	readonly evalCalls: Array<{ source: string; keys: string[] }> = []
	readonly setCalls: Array<{ key: string; options?: FakeSetOptions }> = []
	readonly unlinkCalls: string[][] = []
	readonly scanCalls: Array<{ MATCH?: string; COUNT?: number }> = []
	readonly isReady = true
	readonly isOpen = true
	private scriptLoaded = false

	async evalSha(sha1: string, options: { keys: string[] }): Promise<[number, string | false]> {
		this.evalShaCalls.push({ sha1, keys: [...options.keys] })
		if (!this.scriptLoaded) throw new Error('NOSCRIPT No matching script.')
		return this.cacheReply(options.keys[0]!)
	}

	async eval(source: string, options: { keys: string[] }): Promise<[number, string | false]> {
		this.evalCalls.push({ source, keys: [...options.keys] })
		this.scriptLoaded = true
		return this.cacheReply(options.keys[0]!)
	}

	async set(key: string, value: string, options?: FakeSetOptions): Promise<'OK'> {
		this.values.set(key, value)
		if (options?.expiration) this.ttls.set(key, options.expiration.value)
		else this.ttls.delete(key)
		this.setCalls.push({ key, options })
		return 'OK'
	}

	async unlink(keys: string | string[]): Promise<number> {
		const batch = typeof keys === 'string' ? [keys] : keys
		this.unlinkCalls.push([...batch])
		let deleted = 0
		for (const key of batch) {
			if (this.values.delete(key)) deleted++
			this.ttls.delete(key)
		}
		return deleted
	}

	async *scanIterator(options: { MATCH?: string; COUNT?: number } = {}): AsyncGenerator<string[]> {
		this.scanCalls.push(options)
		const prefix = literalPrefix(options.MATCH ?? '*')
		const keys = [...this.values.keys()].filter((key) => key.startsWith(prefix))
		const count = options.COUNT ?? 10
		for (let offset = 0; offset < keys.length; offset += count) {
			yield keys.slice(offset, offset + count)
		}
	}

	private cacheReply(key: string): [number, string | false] {
		const value = this.values.get(key)
		return value === undefined ? [-2, false] : [this.ttls.get(key) ?? -1, value]
	}
}

function literalPrefix(pattern: string): string {
	const withoutWildcard = pattern.endsWith('*') ? pattern.slice(0, -1) : pattern
	return withoutWildcard.replaceAll(/\\(.)/g, '$1')
}

@Plugin(Redis, { name: 'FakeRedisPlugin' })
class FakeRedisPlugin extends Redis {
	readonly fake = new FakeRedisClient()

	override get client(): RedisClient {
		return this.fake as unknown as RedisClient
	}
}

@Plugin({ name: 'RedisCacheConsumer' })
class RedisCacheConsumer extends BasePlugin {
	constructor(readonly cache: Cache) {
		super()
	}
}

describe('@pluxel/redis cache backend', () => {
	it('rejects Redis prefixes that do not have a stable UTF-8 encoding', () => {
		expect(v.safeParse(RedisCacheBackendConfig, { keyPrefix: 'cache:\u{1f680}:' }).success).toBe(
			true,
		)
		expect(v.safeParse(RedisCacheBackendConfig, { keyPrefix: 'cache:\ud800:' }).success).toBe(false)
		expect(v.safeParse(RedisCacheBackendConfig, { keyPrefix: 'cache:\ud800' }).success).toBe(false)
		expect(v.safeParse(RedisCacheBackendConfig, { keyPrefix: 'cache:\ud801:' }).success).toBe(false)
	})
	it('ships CacheBackend while preserving Redis and Cache capability boundaries', () => {
		expect(getPluginInfo(RedisCacheBackendPlugin).base).toBe(CacheBackend)
		expect(getPluginInfo(FakeRedisPlugin).base).toBe(Redis)
	})

	it('uses registered Lua script and round-trips structured cache values', async () => {
		await withHost(async (host) => {
			host.add([FakeRedisPlugin, RedisCacheBackendPlugin])
			await host.commit()
			const backend = host.require(RedisCacheBackendPlugin)
			const redis = host.require(FakeRedisPlugin).fake
			const value = {
				big: 9_007_199_254_740_993n,
				date: new Date('2026-07-18T00:00:00.000Z'),
				buffer: Buffer.from('pluxel'),
			}

			await backend.set('finite', value, { ttlMs: 2_500 })
			expect(await backend.get<typeof value>('finite')).toEqual({ value, ttlMs: 2_500 })
			expect(redis.evalShaCalls).toHaveLength(1)
			expect(redis.evalCalls).toHaveLength(1)
			expect(await backend.get<typeof value>('finite')).toEqual({ value, ttlMs: 2_500 })
			expect(redis.evalShaCalls).toHaveLength(2)
			expect(redis.evalCalls).toHaveLength(1)

			redis.ttls.set('pluxel:cache:finite', 0)
			expect(await backend.get('finite')).toBeUndefined()

			await backend.set('forever', value, { ttlMs: 0 })
			expect(redis.setCalls.at(-1)).toEqual({ key: 'pluxel:cache:forever', options: undefined })
			expect(await backend.get<typeof value>('forever')).toEqual({ value, ttlMs: 0 })
			await backend.delete('forever')
			expect(await backend.get('forever')).toBeUndefined()

			await backend.set('negative', null, { ttlMs: 1_000 })
			expect(await backend.get('negative')).toEqual({ value: null, ttlMs: 1_000 })
			await expect(backend.set('undefined', undefined, { ttlMs: 1_000 })).rejects.toThrow(
				/undefined/,
			)
		})
	})

	it('clears a managed prefix with SCAN and bounded UNLINK batches', async () => {
		await withHost(async (host) => {
			host.add([FakeRedisPlugin, RedisCacheBackendPlugin])
			host.cfg(RedisCacheBackendPlugin).set({
				config: { keyPrefix: 'pluxel[prod]:cache:', scanCount: 3, deleteBatchSize: 2 },
			})
			await host.commit()
			const backend = host.require(RedisCacheBackendPlugin)
			const redis = host.require(FakeRedisPlugin).fake
			for (const key of ['scope:a', 'scope:b', 'scope:c', 'scope:d', 'other:a']) {
				redis.values.set(`pluxel[prod]:cache:${key}`, 'opaque')
			}

			await backend.clear('scope:')

			expect(redis.scanCalls).toEqual([{ MATCH: 'pluxel\\[prod\\]:cache:scope:*', COUNT: 3 }])
			expect(redis.unlinkCalls.every((batch) => batch.length <= 2)).toBe(true)
			expect([...redis.values.keys()]).toEqual(['pluxel[prod]:cache:other:a'])
		})
	})

	it('switches CachePlugin from memory to built-in Redis backend', async () => {
		await withHost(async (host) => {
			host.add(MemoryCacheBackendPlugin)
			host.add(FakeRedisPlugin)
			host.add(RedisCacheBackendPlugin, { provideBase: false })
			host.add([CachePlugin, RedisCacheConsumer])
			await host.commit()

			const originalConsumer = host.require(RedisCacheConsumer)
			await originalConsumer.cache.set('memory', 'before')
			expect(host.require(FakeRedisPlugin).fake.values.size).toBe(0)

			host.ctx.registry.replaceRuntimeDependencyOverrides(CachePlugin, [RedisCacheBackendPlugin])
			await host.commit()

			const replacedConsumer = host.require(RedisCacheConsumer)
			expect(replacedConsumer).not.toBe(originalConsumer)
			await replacedConsumer.cache.set('redis', 'after')
			expect(
				[...host.require(FakeRedisPlugin).fake.values.keys()].some((key) =>
					key.startsWith('pluxel:cache:plugin:RedisCacheConsumer:'),
				),
			).toBe(true)
		})
	})
})
