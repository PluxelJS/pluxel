import { type PluginConstructor, v } from '@pluxel/runtime'
import { Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
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

@Plugin(Redis)
class FakeRedisPlugin extends Redis {
	readonly fake = new FakeRedisClient()

	override get client(): RedisClient {
		return this.fake as unknown as RedisClient
	}
}

function addStarted(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.start(PluginClass)
}

describe('@pluxel/redis cache backend', () => {
	it('rejects Redis prefixes that do not have a stable UTF-8 encoding', () => {
		expect(v.safeParse(RedisCacheBackendConfig, { keyPrefix: 'cache:\u{1f680}:' }).success).toBe(
			true,
		)
		expect(v.safeParse(RedisCacheBackendConfig, { keyPrefix: 'cache:\ud800:' }).success).toBe(false)
	})

	it('uses registered Lua script and round-trips structured cache values', async () => {
		await withRuntimeHost(async (host) => {
			addStarted(host, [FakeRedisPlugin, RedisCacheBackendPlugin])
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
			expect(redis.ttls.has('pluxel:cache:forever')).toBe(false)
			expect(await backend.get<typeof value>('forever')).toEqual({ value, ttlMs: 0 })
		})
	})

	it('clears a managed prefix with SCAN and bounded UNLINK batches', async () => {
		await withRuntimeHost(async (host) => {
			addStarted(host, [FakeRedisPlugin, RedisCacheBackendPlugin])
			host.cfg(RedisCacheBackendPlugin).set({
				keyPrefix: 'pluxel[prod]:cache:',
				scanCount: 3,
				deleteBatchSize: 2,
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
})
