import { Plugin, withHost } from '@pluxel/test'
import { describe, expect, it, vi } from 'vitest'
import { defineRedisScript, Redis, RedisScriptDecodeError, type RedisClient } from '../src/index.ts'

const Add = defineRedisScript<readonly [string], readonly [string], number>({
	name: 'example.add',
	numberOfKeys: 1,
	source: `return redis.call('INCRBY', KEYS[1], ARGV[1])`,
	decode(reply) {
		const value = Number(reply)
		if (!Number.isSafeInteger(value)) throw new TypeError('Expected an integer.')
		return value
	},
})

const Read = defineRedisScript<readonly [string], readonly [], string>({
	name: 'example.read',
	numberOfKeys: 1,
	readOnly: true,
	source: `return redis.call('GET', KEYS[1])`,
	decode(reply) {
		if (typeof reply !== 'string') throw new TypeError('Expected a string.')
		return reply
	},
})

@Plugin(Redis, { displayName: 'ScriptRedisPlugin' })
class ScriptRedisPlugin extends Redis {
	readonly fake = {
		isOpen: true,
		isReady: true,
		evalSha: vi.fn(),
		eval: vi.fn(),
		evalShaRo: vi.fn(),
		evalRo: vi.fn(),
	}

	override get client(): RedisClient {
		return this.fake as unknown as RedisClient
	}
}

describe('@pluxel/redis scripts', () => {
	it('defines typed scripts and falls back from EVALSHA to EVAL on NOSCRIPT', async () => {
		await withHost(async (host) => {
			host.add(ScriptRedisPlugin)
			await host.commit()
			const redis = host.require(ScriptRedisPlugin)
			redis.fake.evalSha
				.mockRejectedValueOnce(new Error('NOSCRIPT No matching script.'))
				.mockResolvedValueOnce(7)
			redis.fake.eval.mockResolvedValueOnce(5)

			const run = redis.scripts.use(Add)
			expect(redis.scripts.use(Add)).toBe(run)
			expect(Add.sha1).toMatch(/^[a-f0-9]{40}$/)
			expect(await run({ keys: ['counter'], arguments: ['5'] })).toBe(5)
			expect(await run({ keys: ['counter'], arguments: ['2'] })).toBe(7)

			expect(redis.fake.evalSha).toHaveBeenNthCalledWith(1, Add.sha1, {
				keys: ['counter'],
				arguments: ['5'],
			})
			expect(redis.fake.eval).toHaveBeenCalledWith(Add.source, {
				keys: ['counter'],
				arguments: ['5'],
			})

			redis.fake.evalShaRo.mockRejectedValueOnce(new Error('NOSCRIPT missing'))
			redis.fake.evalRo.mockResolvedValueOnce('value')
			expect(await redis.scripts.run(Read, { keys: ['key'] })).toBe('value')
			expect(redis.fake.evalShaRo).toHaveBeenCalledWith(Read.sha1, {
				keys: ['key'],
				arguments: [],
			})
			expect(redis.fake.evalRo).toHaveBeenCalledWith(Read.source, {
				keys: ['key'],
				arguments: [],
			})

			await expect(
				redis.scripts.run(Add, { keys: [] as unknown as readonly [string], arguments: ['1'] }),
			).rejects.toThrow(/requires 1 keys/)

			redis.fake.evalSha.mockResolvedValueOnce('not-an-integer')
			await expect(
				redis.scripts.run(Add, { keys: ['counter'], arguments: ['1'] }),
			).rejects.toBeInstanceOf(RedisScriptDecodeError)
		})
	})
})
