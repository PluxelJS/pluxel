import { createMemoryPersistenceBackend, type PersistenceBackend } from '@pluxel/runtime'
import { BasePlugin, createRuntimeTestHost, Plugin } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import { Cache, CachePlugin, MemoryCacheBackendPlugin } from '../src/index.ts'

@Plugin()
class PersistentCacheConsumer extends BasePlugin {
	constructor(readonly cache: Cache) {
		super()
	}
}

function durableMemoryPersistence(): PersistenceBackend {
	const backend = createMemoryPersistenceBackend()
	return {
		...backend,
		capability: 'durable',
		preflight: async () => undefined,
	}
}

async function withPersistentCache(
	backend: PersistenceBackend,
	fn: (cache: Cache) => Promise<void>,
	options: {
		mode?: 'best-effort' | 'durable'
		maxEntries?: number
		flushIntervalMs?: number
	} = {},
): Promise<void> {
	{
		await using host = createRuntimeTestHost({ persistence: { mode: 'custom', backend } })

		const persistence = {
			mode: options.mode ?? 'durable',
			...(options.flushIntervalMs === undefined
				? {}
				: { flushIntervalMs: options.flushIntervalMs }),
		}
		await host.commit((change) => {
			change.start(MemoryCacheBackendPlugin, {
				initialConfig: {
					...(options.maxEntries === undefined ? {} : { maxEntries: options.maxEntries }),
					persistence,
				},
			})
			change.start(CachePlugin)
			change.start(PersistentCacheConsumer)
		})
		await fn(host.require(PersistentCacheConsumer).cache)
	}
}

describe('MemoryCacheBackendPlugin persistence', () => {
	it('restores structured values with their absolute expiry after restart', async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
			const persistence = durableMemoryPersistence()
			await withPersistentCache(persistence, async (cache) => {
				await cache.set(
					'profile',
					{
						createdAt: new Date('2026-01-01T00:00:00.000Z'),
						roles: new Set(['admin']),
					},
					{ ttlMs: 5_000 },
				)
				await cache.set('expired', 'gone', { ttlMs: 100 })
			})

			vi.advanceTimersByTime(200)
			await withPersistentCache(persistence, async (cache) => {
				expect(await cache.get('profile')).toEqual({
					createdAt: new Date('2026-01-01T00:00:00.000Z'),
					roles: new Set(['admin']),
				})
				expect(await cache.get('expired')).toBeUndefined()
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it('reapplies the current SIEVE capacity while restoring', async () => {
		const persistence = durableMemoryPersistence()
		await withPersistentCache(persistence, async (cache) => {
			await cache.set('a', 1, { ttlMs: 0 })
			await cache.set('b', 2, { ttlMs: 0 })
			await cache.set('c', 3, { ttlMs: 0 })
		})

		await withPersistentCache(
			persistence,
			async (cache) => {
				const values = await Promise.all([cache.get('a'), cache.get('b'), cache.get('c')])
				expect(values.filter((value) => value !== undefined)).toHaveLength(2)
			},
			{ maxEntries: 2 },
		)
	})

	it('requires a serializable value when snapshot persistence is writable', async () => {
		await withPersistentCache(durableMemoryPersistence(), async (cache) => {
			await expect(cache.set('function', (): void => undefined)).rejects.toThrow(/serializable/)
		})
	})

	it('writes a newer revision when delete races an in-flight snapshot', async () => {
		const delegate = durableMemoryPersistence()
		let releaseFirstWrite!: () => void
		const firstWriteGate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve
		})
		let snapshotWrites = 0
		const persistence: PersistenceBackend = {
			...delegate,
			namespace(name) {
				const storage = delegate.namespace(name)
				return {
					...storage,
					async put(key, value, options) {
						if (key === 'memory-backend.snapshot') {
							snapshotWrites++
							if (snapshotWrites === 1) await firstWriteGate
						}
						await storage.put(key, value, options)
					},
				}
			},
		}

		await withPersistentCache(
			persistence,
			async (cache) => {
				await cache.set('racing', 'stale', { ttlMs: 0 })
				await vi.waitFor(() => expect(snapshotWrites).toBe(1))
				await cache.delete('racing')
				releaseFirstWrite()
				await vi.waitFor(() => expect(snapshotWrites).toBe(2))
			},
			{ flushIntervalMs: 0 },
		)

		await withPersistentCache(persistence, async (cache) => {
			expect(await cache.get('racing')).toBeUndefined()
		})
	})

	it('fails lifecycle honestly when durable persistence is unavailable', async () => {
		{
			await using host = createRuntimeTestHost({ persistence: { mode: 'memory' } })

			const failure = await host.commitExpectFail((change) => {
				change.start(MemoryCacheBackendPlugin, {
					initialConfig: {
						maxEntries: 10,
						persistence: { mode: 'durable', flushIntervalMs: 1_000 },
					},
				})
			})
			expect(failure).toHavePluginLifecycleIssue(MemoryCacheBackendPlugin, {
				kind: 'start-failed',
				message: 'ephemeral',
			})
		}
	})

	it('reports durable snapshot read failures without misclassifying them as corruption', async () => {
		const delegate = durableMemoryPersistence()
		const persistence: PersistenceBackend = {
			...delegate,
			namespace(name) {
				const storage = delegate.namespace(name)
				return {
					...storage,
					async get(key) {
						if (key === 'memory-backend.snapshot') throw new Error('storage unavailable')
						return await storage.get(key)
					},
				}
			},
		}

		{
			await using host = createRuntimeTestHost({
				persistence: { mode: 'custom', backend: persistence },
			})

			const failure = await host.commitExpectFail((change) => {
				change.start(MemoryCacheBackendPlugin, {
					initialConfig: {
						maxEntries: 10,
						persistence: { mode: 'durable', flushIntervalMs: 1_000 },
					},
				})
			})
			expect(failure).toHavePluginLifecycleIssue(MemoryCacheBackendPlugin, {
				kind: 'start-failed',
				message: 'could not be restored',
			})
		}
	})

	it('starts empty and replaces a corrupt best-effort snapshot', async () => {
		const persistence = createMemoryPersistenceBackend()
		await persistence
			.namespace('@pluxel/cache')
			.put('memory-backend.snapshot', new Uint8Array([1, 2, 3]), { atomic: true })

		await withPersistentCache(
			persistence,
			async (cache) => {
				expect(await cache.get('missing')).toBeUndefined()
				await cache.set('healthy', true, { ttlMs: 0 })
			},
			{ mode: 'best-effort' },
		)
		await withPersistentCache(
			persistence,
			async (cache) => {
				expect(await cache.get('healthy')).toBe(true)
			},
			{ mode: 'best-effort' },
		)
	})
})
