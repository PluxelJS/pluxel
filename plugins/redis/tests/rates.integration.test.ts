import { createHash, randomUUID } from 'node:crypto'
import { Rates, RatesPlugin, type RatePolicy } from '@pluxel/rates'
import type { PluginConstructor } from '@pluxel/runtime'
import { BasePlugin, Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it } from 'vitest'
import { RedisPlugin, RedisRatesBackendPlugin } from '../src/index.ts'

const redisUrl = process.env.PLUXEL_REDIS_TEST_URL

@Plugin({ displayName: 'RedisRatesIntegrationConsumer' })
class IntegrationConsumer extends BasePlugin {
	constructor(readonly rates: Rates) {
		super()
	}
}

function addEnabled(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.cfg(PluginClass).enable()
}

const algorithms = [
	{ algorithm: 'token-bucket', limit: 3, windowMs: 100, burst: 3 },
	{ algorithm: 'fixed-window', limit: 3, windowMs: 100 },
	{ algorithm: 'sliding-window-counter', limit: 3, windowMs: 100 },
	{ algorithm: 'sliding-window-log', limit: 3, windowMs: 100 },
] satisfies RatePolicy[]

describe.skipIf(!redisUrl)('Redis 7 rates integration', () => {
	it('executes all algorithms atomically, keeps policy in state, and recovers after SCRIPT FLUSH', async () => {
		const prefix = `pluxel:test:rates:${randomUUID()}:`
		await withRuntimeHost(async (host) => {
			addEnabled(host, [RedisPlugin, RedisRatesBackendPlugin, RatesPlugin, IntegrationConsumer])
			host.cfg(RedisPlugin).set({ url: redisUrl! })
			host.cfg(RedisRatesBackendPlugin).set({ keyPrefix: prefix })
			await host.commit()
			const consumer = host.require(IntegrationConsumer)
			const redis = host.require(RedisPlugin).client as unknown as IntegrationRedisClient
			try {
				for (const policy of algorithms) {
					const limiter = consumer.rates.use(`integration.${policy.algorithm}`, policy)
					expect(await limiter.consume('user', { cost: 2 })).toMatchObject({
						denied: false,
						remaining: 1,
					})
					expect(await limiter.consume('user', { cost: 2 })).toMatchObject({
						denied: true,
						remaining: 1,
					})
				}
				for (const algorithm of algorithms.map((policy) => policy.algorithm)) {
					const policy =
						algorithm === 'token-bucket'
							? ({ algorithm, limit: 1, windowMs: 3_600_000, burst: 25 } as const)
							: ({ algorithm, limit: 25, windowMs: 3_600_000 } as const)
					const limiter = consumer.rates.use(`integration.concurrent.${algorithm}`, policy)
					const decisions = await Promise.all(
						Array.from({ length: 80 }, () => limiter.consume('same')),
					)
					expect(decisions.filter((decision) => !decision.denied)).toHaveLength(25)
				}

				const largeDeny = consumer.rates.use('integration.large-log-deny', {
					algorithm: 'sliding-window-log',
					limit: 130,
					windowMs: 60_000,
				})
				const largeAllows = await Promise.all(
					Array.from({ length: 130 }, () => largeDeny.consume('same')),
				)
				expect(largeAllows.every((decision) => !decision.denied)).toBe(true)
				await expect(largeDeny.consume('same', { cost: 130 })).resolves.toMatchObject({
					denied: true,
					remaining: 0,
				})

				const partialExpiry = consumer.rates.use('integration.partial-expiry', {
					algorithm: 'sliding-window-log',
					limit: 5,
					windowMs: 1_000,
				})
				await partialExpiry.consume('same', { cost: 2 })
				await new Promise((resolve) => setTimeout(resolve, 550))
				await partialExpiry.consume('same', { cost: 2 })
				await new Promise((resolve) => setTimeout(resolve, 550))
				await expect(partialExpiry.consume('same', { cost: 3 })).resolves.toMatchObject({
					denied: false,
					remaining: 0,
				})

				const backend = host.require(RedisRatesBackendPlugin)
				const fixed = Object.freeze({
					algorithm: 'fixed-window',
					limit: 2,
					windowMs: 60_000,
				} as const)
				const logPolicy = Object.freeze({
					algorithm: 'sliding-window-log',
					limit: 2,
					windowMs: 60_000,
				} as const)
				await backend.consume({ key: 'cross-type-policy', owner: null, policy: logPolicy, cost: 1 })
				await expect(
					backend.consume({ key: 'cross-type-policy', owner: null, policy: fixed, cost: 1 }),
				).rejects.toMatchObject({ code: 'RATES_POLICY_CONFLICT', active: logPolicy })
				await backend.consume({ key: 'owner-mismatch', owner: null, policy: fixed, cost: 1 })
				await expect(
					backend.consume({
						key: 'owner-mismatch',
						owner: consumer.ctx.pluginInfo.nodeAddress,
						policy: fixed,
						cost: 1,
					}),
				).rejects.toThrow('unsupported format')

				const expiringKey = 'expired-policy'
				await backend.consume({
					key: expiringKey,
					owner: null,
					policy: Object.freeze({ algorithm: 'fixed-window', limit: 1, windowMs: 20 }),
					cost: 1,
				})
				await new Promise((resolve) => setTimeout(resolve, 40))
				await expect(
					backend.consume({
						key: expiringKey,
						owner: null,
						policy: Object.freeze({
							algorithm: 'token-bucket',
							limit: 1,
							windowMs: 20,
							burst: 1,
						}),
						cost: 1,
					}),
				).resolves.toMatchObject({ denied: false })

				await redis.scriptFlush()
				await expect(
					consumer.rates.use('integration.after-flush', algorithms[0]!).consume('user'),
				).resolves.toMatchObject({ denied: false })

				const rollbackLogicalKey = 'clock-rollback-state'
				const rollbackStorageKey = storageKey(prefix, rollbackLogicalKey)
				const future = Date.now() + 5_000
				await redis.hSet(rollbackStorageKey, {
					version: '2',
					algorithm: 'token-bucket',
					limit: '2',
					window: '1000',
					burst: '2',
					observedAt: String(future),
					owner: 'null',
					balance: '0',
					updatedAt: String(future),
				})
				await redis.pExpire(rollbackStorageKey, 10_000)
				await expect(
					backend.consume({
						key: rollbackLogicalKey,
						owner: null,
						policy: Object.freeze({
							algorithm: 'token-bucket',
							limit: 2,
							windowMs: 1_000,
							burst: 2,
						}),
						cost: 1,
					}),
				).resolves.toEqual({
					denied: true,
					remaining: 0,
					retryAfterMs: 500,
					resetAt: future + 1_000,
				})

				const malformedHashLogicalKey = 'malformed-hash-state'
				const malformedHashKey = storageKey(prefix, malformedHashLogicalKey)
				await redis.hSet(malformedHashKey, {
					version: '2',
					algorithm: 'fixed-window',
					limit: '2',
					window: '60000',
					burst: '0',
					observedAt: String(Date.now()),
					owner: 'null',
				})
				await expect(
					backend.consume({ key: malformedHashLogicalKey, owner: null, policy: fixed, cost: 1 }),
				).rejects.toThrow('invalid reply')
				expect(await redis.exists(malformedHashKey)).toBe(1)

				const malformedLogLogicalKey = 'malformed-log-state'
				const malformedLogKey = storageKey(prefix, malformedLogLogicalKey)
				const observed = Date.now()
				await redis.zAdd(malformedLogKey, [
					{
						score: -1,
						value: `m|2|sliding-window-log|2|60000|1|${observed}|${observed}|0|null`,
					},
					{ score: observed - 1, value: `e|${observed - 1}|0|1` },
					{ score: observed, value: `e|${observed}|0|1` },
				])
				await expect(
					backend.consume({
						key: malformedLogLogicalKey,
						owner: null,
						policy: Object.freeze({
							algorithm: 'sliding-window-log',
							limit: 2,
							windowMs: 60_000,
						}),
						cost: 1,
					}),
				).rejects.toThrow('invalid reply')
				expect(await redis.exists(malformedLogKey)).toBe(1)
			} finally {
				await unlinkPrefix(redis, prefix)
			}
		})
	})
})

type IntegrationRedisClient = {
	scanIterator(options: { MATCH: string; COUNT: number }): AsyncIterable<Array<string | Buffer>>
	unlink(keys: string[]): Promise<number>
	scriptFlush(): Promise<unknown>
	hSet(key: string, fields: Record<string, string>): Promise<number>
	zAdd(key: string, members: Array<{ score: number; value: string }>): Promise<number>
	exists(key: string): Promise<number>
	pExpire(key: string, milliseconds: number): Promise<number>
}

function storageKey(prefix: string, logicalKey: string): string {
	return `${prefix}v3:${createHash('sha256').update(logicalKey).digest('hex')}`
}

async function unlinkPrefix(client: IntegrationRedisClient, prefix: string): Promise<void> {
	const keys: string[] = []
	for await (const batch of client.scanIterator({ MATCH: `${prefix}*`, COUNT: 100 })) {
		keys.push(...batch.map(String))
		if (keys.length >= 100) await flushKeys(client, keys)
	}
	await flushKeys(client, keys)
}

async function flushKeys(client: IntegrationRedisClient, keys: string[]): Promise<void> {
	if (keys.length === 0) return
	await client.unlink([...keys])
	keys.length = 0
}
