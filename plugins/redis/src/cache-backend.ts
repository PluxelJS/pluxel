import { deserialize, serialize } from 'node:v8'
import { CacheBackend, type CacheValue } from '@pluxel/cache'
import { Plugin, v } from '@pluxel/runtime'
import { Redis } from './client.ts'
import { defineRedisScript } from './scripts.ts'
import { isWellFormedUnicode } from './validation.ts'

const REDIS_CACHE_FORMAT = 'pluxel-cache:v1:'

const GetCacheValue = defineRedisScript<
	readonly [string],
	readonly [],
	CacheValue<unknown> | undefined
>({
	name: 'pluxel.cache.get-with-ttl',
	numberOfKeys: 1,
	source: `
local value = redis.call('GET', KEYS[1])
if not value then return {-2, false} end
return {redis.call('PTTL', KEYS[1]), value}
`,
	decode(reply) {
		if (!Array.isArray(reply) || reply.length !== 2) {
			throw new TypeError('Expected [pttl, value].')
		}
		const ttlMs = Number(reply[0])
		const encoded = reply[1]
		if (ttlMs === -2 || encoded === null || encoded === false) return undefined
		if (!Number.isSafeInteger(ttlMs) || ttlMs === 0 || ttlMs < -1) return undefined
		if (typeof encoded !== 'string') throw new TypeError('Expected a string cache value.')
		return {
			value: decodeRedisCacheValue(encoded),
			ttlMs: ttlMs === -1 ? 0 : ttlMs,
		}
	},
})

export const RedisCacheBackendConfig = v.object({
	keyPrefix: v.optional(
		v.pipe(v.string(), v.check(isWellFormedUnicode, 'keyPrefix must be well-formed Unicode')),
		'pluxel:cache:',
	),
	scanCount: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 200),
	deleteBatchSize: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 200),
})

export type RedisCacheBackendPluginConfig = v.InferOutput<typeof RedisCacheBackendConfig>

/** CacheBackend adapter shipped with @pluxel/redis. */
@Plugin(CacheBackend, { name: 'RedisCacheBackendPlugin' })
export class RedisCacheBackendPlugin extends CacheBackend {
	private readonly config = this.configs.use(RedisCacheBackendConfig)

	constructor(private readonly redis: Redis) {
		super()
	}

	async get<V>(key: string): Promise<CacheValue<V> | undefined> {
		return (await this.redis.scripts.run(GetCacheValue, {
			keys: [this.redisKey(key)],
		})) as CacheValue<V> | undefined
	}

	async set<V>(key: string, value: V, { ttlMs }: { ttlMs: number }): Promise<void> {
		if (value === undefined) throw new TypeError('Cache values cannot be undefined.')
		if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
			throw new RangeError('Cache ttlMs must be a non-negative safe integer.')
		}
		const redisKey = this.redisKey(key)
		const encoded = encodeRedisCacheValue(value)
		if (ttlMs === 0) await this.redis.client.set(redisKey, encoded)
		else
			await this.redis.client.set(redisKey, encoded, {
				expiration: { type: 'PX', value: ttlMs },
			})
	}

	async delete(key: string): Promise<void> {
		await this.redis.client.unlink(this.redisKey(key))
	}

	async clear(prefix: string): Promise<void> {
		const client = this.redis.client
		const match = `${escapeRedisGlob(this.redisKey(prefix))}*`
		for await (const keys of client.scanIterator({ MATCH: match, COUNT: this.config.scanCount })) {
			for (let offset = 0; offset < keys.length; offset += this.config.deleteBatchSize) {
				await client.unlink(keys.slice(offset, offset + this.config.deleteBatchSize))
			}
		}
	}

	private redisKey(key: string): string {
		return `${this.config.keyPrefix}${key}`
	}
}

function encodeRedisCacheValue(value: unknown): string {
	try {
		return `${REDIS_CACHE_FORMAT}${Buffer.from(serialize(value)).toString('base64')}`
	} catch (error) {
		throw new TypeError(
			'Redis cache value is not serializable by the Node structured clone codec.',
			{
				cause: error,
			},
		)
	}
}

function decodeRedisCacheValue(encoded: string): unknown {
	if (!encoded.startsWith(REDIS_CACHE_FORMAT)) {
		throw new TypeError('Redis cache value has an unsupported serialization format.')
	}
	try {
		return deserialize(Buffer.from(encoded.slice(REDIS_CACHE_FORMAT.length), 'base64'))
	} catch (error) {
		throw new TypeError('Redis cache value is corrupt or cannot be deserialized.', { cause: error })
	}
}

function escapeRedisGlob(value: string): string {
	return value.replaceAll(/[\\*?[\]]/g, '\\$&')
}
