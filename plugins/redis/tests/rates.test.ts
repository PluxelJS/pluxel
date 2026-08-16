import { Rates, RatesPlugin, type RatePolicy } from '@pluxel/rates'
import { v } from '@pluxel/runtime'
import { BasePlugin, Plugin, withHost } from '@pluxel/test'
import { describe, expect, it } from 'vitest'
import {
	Redis,
	RedisRatesBackendConfig,
	RedisRatesBackendPlugin,
	type RedisClient,
} from '../src/index.ts'

type ScriptOptions = { keys: string[]; arguments: string[] }

class FakeRatesRedisClient {
	readonly evalShaCalls: Array<{ sha1: string; options: ScriptOptions }> = []
	readonly evalCalls: Array<{ source: string; options: ScriptOptions }> = []
	readonly isReady = true
	readonly isOpen = true
	scriptLoaded = false
	reply: unknown = [1, 0, 5_001_000]

	async evalSha(sha1: string, options: ScriptOptions): Promise<unknown> {
		this.evalShaCalls.push({ sha1, options: cloneOptions(options) })
		if (!this.scriptLoaded) throw new Error('NOSCRIPT No matching script.')
		return this.reply
	}

	async eval(source: string, options: ScriptOptions): Promise<unknown> {
		this.evalCalls.push({ source, options: cloneOptions(options) })
		this.scriptLoaded = true
		return this.reply
	}
}

function cloneOptions(options: ScriptOptions): ScriptOptions {
	return { keys: [...options.keys], arguments: [...options.arguments] }
}

@Plugin(Redis)
class FakeRatesRedisPlugin extends Redis {
	readonly fake = new FakeRatesRedisClient()
	override get client(): RedisClient {
		return this.fake as unknown as RedisClient
	}
}

@Plugin()
class RedisRatesConsumer extends BasePlugin {
	constructor(readonly rates: Rates) {
		super()
	}
}

const policies = [
	{ algorithm: 'token-bucket', limit: 2, windowMs: 1_000, burst: 3 },
	{ algorithm: 'fixed-window', limit: 2, windowMs: 1_000 },
	{ algorithm: 'sliding-window-counter', limit: 2, windowMs: 1_000 },
	{ algorithm: 'sliding-window-log', limit: 2, windowMs: 1_000 },
] satisfies RatePolicy[]

describe('@pluxel/redis rates backend', () => {
	it('rejects Redis prefixes that do not have a stable UTF-8 encoding', () => {
		expect(v.safeParse(RedisRatesBackendConfig, { keyPrefix: 'rates:\u{1f680}:' }).success).toBe(
			true,
		)
		expect(v.safeParse(RedisRatesBackendConfig, { keyPrefix: 'rates:\ud800:' }).success).toBe(false)
	})
	it('selects one server-timed single-key script for each algorithm and digests identity keys', async () => {
		await withHost(async (host) => {
			host.add([FakeRatesRedisPlugin, RedisRatesBackendPlugin, RatesPlugin, RedisRatesConsumer])
			host.cfg(RedisRatesBackendPlugin).set({ keyPrefix: 'pluxel:{rates}:' })
			await host.commit()
			const consumer = host.require(RedisRatesConsumer)
			const redis = host.require(FakeRatesRedisPlugin).fake
			let slidingLogSource = ''

			for (const policy of policies) {
				redis.scriptLoaded = false
				const decision = await consumer.rates
					.use(`messages.${policy.algorithm}`, policy)
					.consume({ tenant: 'secret-tenant', user: 7 })
				expect(decision).toEqual({ denied: false, remaining: 0, resetAt: 5_001_000 })
				const call = redis.evalCalls.at(-1)!
				expect(call.source).toContain("redis.call('TIME')")
				expect(call.source).toContain("redis.call('PEXPIRE'")
				if (policy.algorithm === 'sliding-window-log') slidingLogSource = call.source
				expect(call.options.keys).toHaveLength(1)
				expect(call.options.keys[0]).toMatch(/^pluxel:\{rates\}:v2:[a-f0-9]{64}$/)
				expect(call.options.keys[0]).not.toContain('secret-tenant')
				expect(call.options.arguments).toEqual([
					String(policy.limit),
					String(policy.windowMs),
					String(policy.algorithm === 'token-bucket' ? policy.burst : 0),
					JSON.stringify(consumer.ctx.pluginInfo.nodeAddress),
					'1',
				])
			}
			expect(slidingLogSource).not.toContain("redis.call('ZRANGE', key, 0, -1")
			expect(slidingLogSource).not.toContain('SCAN_BATCH')
			expect(slidingLogSource).not.toContain("'WITHSCORES', 'LIMIT', offset")
			expect(slidingLogSource).toContain("'(' .. cutoff, '+inf', 'WITHSCORES'")
			expect(redis.evalShaCalls).toHaveLength(4)
			expect(redis.evalCalls).toHaveLength(4)
		})
	})

	it('uses EVALSHA after load, recovers from NOSCRIPT once, and decodes deny', async () => {
		await withHost(async (host) => {
			host.add([FakeRatesRedisPlugin, RedisRatesBackendPlugin, RatesPlugin, RedisRatesConsumer])
			await host.commit()
			const limiter = host.require(RedisRatesConsumer).rates.use('stable', policies[0]!)
			const redis = host.require(FakeRatesRedisPlugin).fake
			await limiter.consume('first')
			redis.reply = [0, 0, 250, 5_001_000]
			expect(await limiter.consume('second')).toEqual({
				denied: true,
				remaining: 0,
				retryAfterMs: 250,
				resetAt: 5_001_000,
			})
			expect(redis.evalCalls).toHaveLength(1)
			redis.scriptLoaded = false
			await limiter.consume('third')
			expect(redis.evalCalls).toHaveLength(2)
		})
	})

	it('preserves structured policy conflicts and rejects corrupt replies', async () => {
		await withHost(async (host) => {
			host.add([FakeRatesRedisPlugin, RedisRatesBackendPlugin, RatesPlugin, RedisRatesConsumer])
			await host.commit()
			const limiter = host.require(RedisRatesConsumer).rates.use('conflict', policies[1]!)
			const redis = host.require(FakeRatesRedisPlugin).fake
			redis.reply = [-1, 'token-bucket', 10, 60_000, 20]
			await expect(limiter.consume('user')).rejects.toMatchObject({
				code: 'RATES_POLICY_CONFLICT',
				active: { algorithm: 'token-bucket', limit: 10, windowMs: 60_000, burst: 20 },
				requested: policies[1],
			})
			redis.reply = [-2]
			await expect(limiter.consume('other')).rejects.toMatchObject({ code: 'RATES_UNAVAILABLE' })
		})
	})
})
