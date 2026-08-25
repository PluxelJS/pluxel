import type { PluginConstructor } from '@pluxel/runtime'
import { BasePlugin, Plugin, type RuntimeHost, withRuntimeHost } from '@pluxel/runtime/test'
import { describe, expect, it, vi } from 'vitest'
import {
	Cache,
	CacheBackend,
	CachePolicyConflictError,
	CacheBusyError,
	Cached,
	CachePlugin,
	CacheStoppedError,
	type CacheValue,
	MemoryCacheBackendPlugin,
	Memoized,
} from '../src/index.ts'

function addEnabled(host: RuntimeHost, plugins: readonly PluginConstructor[]): void {
	host.add(plugins)
	for (const PluginClass of plugins) host.cfg(PluginClass).enable()
}

function withHost<T>(fn: (host: RuntimeHost) => Promise<T> | T): Promise<T> {
	return withRuntimeHost(fn, { workbench: false })
}

type User = { id: string; name: string }

@Plugin({ displayName: 'CacheConsumer' })
class ConsumerA extends BasePlugin {
	constructor(readonly cache: Cache) {
		super()
	}
}

@Plugin({ displayName: 'CacheConsumer' })
class ConsumerB extends BasePlugin {
	constructor(readonly cache: Cache) {
		super()
	}
}

@Plugin({ displayName: 'DecoratedCacheConsumer' })
class DecoratedConsumer extends BasePlugin {
	asyncCalls = 0
	syncCalls = 0
	explicitCalls = 0
	pairCalls = 0
	gate: Promise<void> = Promise.resolve()

	constructor(readonly cache: Cache) {
		super()
	}

	@Cached({ ttlMs: 1_000 })
	async user(id: string): Promise<User> {
		this.asyncCalls++
		await this.gate
		return { id, name: `user-${id}` }
	}

	@Memoized({ ttlMs: 1_000 })
	double(value: number): number {
		this.syncCalls++
		return value * 2
	}

	@Cached({ name: 'decorated' })
	async explicit(id: string): Promise<User> {
		this.explicitCalls++
		return { id, name: `explicit-${id}` }
	}

	@Cached({
		name: 'pairs',
		key: (group: string, id: string) => [group, id],
	})
	async pair(group: string, id: string): Promise<User> {
		this.pairCalls++
		return { id, name: `${group}-${id}` }
	}
}

@Plugin(CacheBackend)
class TestCacheBackendPlugin extends CacheBackend {
	readonly values = new Map<string, CacheValue<unknown>>()
	readonly metrics = { gets: 0, sets: 0, deletes: 0 }
	getGate: Promise<void> | undefined
	getError: Error | undefined
	setError: Error | undefined

	async get<V>(key: string): Promise<CacheValue<V> | undefined> {
		this.metrics.gets++
		await this.getGate
		if (this.getError) throw this.getError
		return this.values.get(key) as CacheValue<V> | undefined
	}

	async set<V>(key: string, value: V, { ttlMs }: { ttlMs: number }): Promise<void> {
		this.metrics.sets++
		if (this.setError) throw this.setError
		this.values.set(key, { value, ttlMs })
	}

	async delete(key: string): Promise<void> {
		this.metrics.deletes++
		this.values.delete(key)
	}

	async clear(prefix: string): Promise<void> {
		for (const key of this.values.keys()) {
			if (key.startsWith(prefix)) this.values.delete(key)
		}
	}
}

@Plugin(CacheBackend)
class MissingClearCacheBackend extends CacheBackend {
	private readonly values = new Map<string, CacheValue<unknown>>()
	override clear = undefined as never

	async get<V>(key: string): Promise<CacheValue<V> | undefined> {
		return this.values.get(key) as CacheValue<V> | undefined
	}

	async set<V>(key: string, value: V, options: { ttlMs: number }): Promise<void> {
		this.values.set(key, { value, ttlMs: options.ttlMs })
	}

	async delete(key: string): Promise<void> {
		this.values.delete(key)
	}
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((res, rej) => {
		resolve = res
		reject = rej
	})
	return { promise, resolve, reject }
}

describe('@pluxel/cache', () => {
	it('keeps scoped L1 synchronous, bounded, TTL-aware, and independently configurable', async () => {
		vi.useFakeTimers()
		try {
			await withHost(async (host) => {
				addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
				host.cfg(CachePlugin).set({ ttlMs: 20, maxEntries: 2 })
				await host.commit()
				const cache = host.require(ConsumerA).cache
				cache.local.set('default', 0)
				const l1 = cache.scope('hot', {
					ttlMs: 100,
					maxEntries: 2,
				}).local

				l1.set('a', 1)
				l1.set('b', 2)
				expect(l1.get<number>('a')).toBe(1)
				l1.set('c', 3)
				expect(l1.get('b')).toBeUndefined()
				expect(l1.get('a')).not.toBeInstanceOf(Promise)
				expect(l1.stats().evictions).toBe(1)
				vi.advanceTimersByTime(21)
				expect(cache.local.get('default')).toBeUndefined()
				expect(l1.get('a')).toBe(1)
				vi.advanceTimersByTime(80)
				expect(l1.get('a')).toBeUndefined()
			})
		} finally {
			vi.useRealTimers()
		}
	})

	it('uses the default memory backend as an async L2 behind local cache', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache.scope('memory-l2', { maxEntries: 1 })
			await cache.set('a', 1)
			await cache.set('b', 2)
			expect(cache.local.get('a')).toBeUndefined()
			expect(await cache.get<number>('a')).toBe(1)
			expect(cache.stats().backendHits).toBe(1)
		})
	})

	it('uses node identity for caller isolation while global uses one managed shared namespace', async () => {
		await withHost(async (host) => {
			addEnabled(host, [TestCacheBackendPlugin, CachePlugin, ConsumerA, ConsumerB])
			await host.commit()
			const a = host.require(ConsumerA)
			const b = host.require(ConsumerB)
			const backend = host.require(TestCacheBackendPlugin)

			await a.cache.set('user:1', { id: '1', name: 'private' })
			expect(await b.cache.get('user:1')).toBeUndefined()

			await a.cache.global.set('user:1', { id: '1', name: 'shared' })
			expect(await b.cache.global.get<User>('user:1')).toEqual({
				id: '1',
				name: 'shared',
			})
			const privateEntry = [...backend.values.entries()].find(([key]) =>
				/^cache:v3:plugin:[a-f0-9]{64}:v1\|p\|s6:user:1$/.test(key),
			)
			const globalEntry = backend.values.get('cache:v3:global:v1|p|s6:user:1')
			expect(privateEntry?.[1].value).toMatchObject({
				format: 'pluxel-cache-entry',
				version: 1,
				owner: a.ctx.pluginInfo.nodeAddress,
				value: { id: '1', name: 'private' },
			})
			expect(globalEntry?.value).toMatchObject({
				format: 'pluxel-cache-entry',
				version: 1,
				owner: null,
				value: { id: '1', name: 'shared' },
			})
		})
	})

	it('rejects a backend entry whose structured owner does not match its physical key', async () => {
		await withHost(async (host) => {
			addEnabled(host, [TestCacheBackendPlugin, CachePlugin, ConsumerA, ConsumerB])
			await host.commit()
			const a = host.require(ConsumerA)
			const b = host.require(ConsumerB)
			const backend = host.require(TestCacheBackendPlugin)
			await a.cache.set('owned', 'value')
			const [key, entry] = [...backend.values.entries()].find(([candidate]) =>
				candidate.endsWith('v1|p|s5:owned'),
			)!
			backend.values.set(key, {
				...entry,
				value: {
					...(entry.value as Record<string, unknown>),
					owner: b.ctx.pluginInfo.nodeAddress,
				},
			})
			a.cache.local.delete('owned')
			await expect(a.cache.get('owned')).rejects.toThrow('owner does not match')
			backend.values.set(key, { ...entry, value: 'legacy-raw-value' })
			await expect(a.cache.get('owned')).rejects.toThrow('entry must be an object')
		})
	})

	it('deduplicates a global loader across consumers and does not cache rejection', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA, ConsumerB])
			await host.commit()
			const a = host.require(ConsumerA).cache.global
			const b = host.require(ConsumerB).cache.global
			const gate = deferred<User>()
			let loads = 0
			const load = () => {
				loads++
				return gate.promise
			}

			const left = a.getOrLoad('1', load)
			const right = b.getOrLoad('1', load)
			gate.resolve({ id: '1', name: 'Ada' })
			expect(await Promise.all([left, right])).toEqual([
				{ id: '1', name: 'Ada' },
				{ id: '1', name: 'Ada' },
			])
			expect(loads).toBe(1)
			expect(a.stats().deduplicated).toBe(1)

			await expect(
				a.getOrLoad('bad', async () => Promise.reject(new Error('boom'))),
			).rejects.toThrow('boom')
			expect(await a.get('bad')).toBeUndefined()

			let missingLoads = 0
			expect(
				await a.getOrLoad('missing', (): null => {
					missingLoads++
					return null
				}),
			).toBeNull()
			expect(await a.getOrLoad('missing', () => 'unexpected')).toBeNull()
			expect(missingLoads).toBe(1)
			await expect(a.getOrLoad('undefined', (): undefined => undefined)).rejects.toThrow(
				/undefined/,
			)
		})
	})

	it('coalesces an external miss and preserves per-subscriber abort', async () => {
		await withHost(async (host) => {
			addEnabled(host, [TestCacheBackendPlugin, CachePlugin, ConsumerA, ConsumerB])
			await host.commit()
			const backend = host.require(TestCacheBackendPlugin)
			const a = host.require(ConsumerA).cache.global
			const b = host.require(ConsumerB).cache.global
			const external = deferred<void>()
			backend.getGate = external.promise
			let loads = 0

			const plainRead = a.get('2')
			const controller = new AbortController()
			const aborted = b.getOrLoad('2', async () => ({ id: '2', name: 'Grace' }), {
				signal: controller.signal,
			})
			const surviving = a.getOrLoad('2', async () => {
				loads++
				return { id: '2', name: 'Grace' }
			})
			controller.abort()
			external.resolve()

			await expect(aborted).rejects.toMatchObject({ name: 'AbortError' })
			expect(await plainRead).toBeUndefined()
			expect(await surviving).toEqual({ id: '2', name: 'Grace' })
			expect(backend.metrics.gets).toBe(1)
			expect(backend.metrics.sets).toBe(1)
			expect(loads).toBe(1)
		})
	})

	it('supports cache-first, cache-and-refresh, and remote-first async reads', async () => {
		await withHost(async (host) => {
			addEnabled(host, [TestCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const backend = host.require(TestCacheBackendPlugin)
			const cache = host.require(ConsumerA).cache
			const cacheFirst = cache.scope('cache-first')
			await cacheFirst.set('k', 'remote')
			cacheFirst.local.set('k', 'memory')
			const getsBefore = backend.metrics.gets
			expect(await cacheFirst.get<string>('k')).toBe('memory')
			expect(backend.metrics.gets).toBe(getsBefore)

			const refresh = cache.scope('refresh', { readPolicy: 'cache-and-refresh' })
			await refresh.set('k', 'remote')
			refresh.local.set('k', 'memory')
			expect(await refresh.get<string>('k')).toBe('memory')
			await vi.waitFor(() => expect(refresh.local.get<string>('k')).toBe('remote'))

			const remoteFirst = cache.scope('remote-first', { readPolicy: 'remote-first' })
			await remoteFirst.set('k', 'remote')
			remoteFirst.local.set('k', 'memory')
			expect(await remoteFirst.get<string>('k')).toBe('remote')
		})
	})

	it('orders invalidation after in-flight load', async () => {
		await withHost(async (host) => {
			addEnabled(host, [TestCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache
			const gate = deferred<User>()
			const loading = cache.getOrLoad('3', () => gate.promise)
			const deleting = cache.delete('3')
			gate.resolve({ id: '3', name: 'late' })
			await loading
			await deleting
			expect(await cache.get('3')).toBeUndefined()
		})
	})

	it('fails loudly instead of reporting a local-only clear as successful', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MissingClearCacheBackend, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache
			await cache.set('value', 1)
			await expect(cache.clear()).rejects.toBeInstanceOf(TypeError)
			expect(cache.local.get('value')).toBe(1)
		})
	})

	it('revokes cached namespace handles when provider stops', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const handle = host.require(ConsumerA).cache.scope('saved')
			await handle.set('live', 1)
			host.cfg(CachePlugin).disable()
			await host.commit()
			await expect(handle.get('live')).rejects.toBeInstanceOf(CacheStoppedError)
		})
	})

	it('revokes caller-local, global, and decorator handles when the caller stops', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, DecoratedConsumer])
			await host.commit()
			const consumer = host.require(DecoratedConsumer)
			const local = consumer.cache.scope('saved')
			const global = consumer.cache.global
			await local.set('live', 1)
			await global.set('live', 1)
			await consumer.user('1')

			host.cfg(DecoratedConsumer).disable()
			await host.commit()

			await expect(local.get('live')).rejects.toBeInstanceOf(CacheStoppedError)
			await expect(global.get('live')).rejects.toBeInstanceOf(CacheStoppedError)
			expect(() => consumer.user('1')).toThrow('Plugin owner stopped')
		})
	})

	it('keeps a shared global registration alive until its final owner stops', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA, ConsumerB])
			await host.commit()
			const a = host.require(ConsumerA).cache.global
			const b = host.require(ConsumerB).cache.global
			await a.set('shared', 1)

			host.cfg(ConsumerA).disable()
			await host.commit()

			await expect(a.get('shared')).rejects.toBeInstanceOf(CacheStoppedError)
			expect(await b.get('shared')).toBe(1)
		})
	})

	it('does not let a stopped memory backend handle recreate its state', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const backend = host.require(MemoryCacheBackendPlugin)
			await backend.set('saved', 1, { ttlMs: 0 })

			for (const PluginClass of [ConsumerA, CachePlugin, MemoryCacheBackendPlugin]) {
				host.cfg(PluginClass).disable()
			}
			await host.commit()

			await expect(backend.get('saved')).rejects.toBeInstanceOf(CacheStoppedError)
			await expect(backend.set('late', 2, { ttlMs: 0 })).rejects.toBeInstanceOf(CacheStoppedError)
		})
	})

	it('bounds distinct in-flight work while allowing same-key joins', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache.scope('backpressure', { maxInFlight: 1 })
			const gate = deferred<number>()
			const first = cache.getOrLoad('a', () => gate.promise)
			const joined = cache.getOrLoad('a', () => 99)
			await expect(cache.getOrLoad('b', () => 2)).rejects.toBeInstanceOf(CacheBusyError)
			expect(cache.stats().rejected).toBe(1)
			gate.resolve(1)
			expect(await Promise.all([first, joined])).toEqual([1, 1])
		})
	})

	it('supports @Cached, @Memoized, custom method scopes, and explicit invalidation', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, DecoratedConsumer])
			await host.commit()
			const consumer = host.require(DecoratedConsumer)
			const gate = deferred<void>()
			consumer.gate = gate.promise
			const first = consumer.user('1')
			const joined = consumer.user('1')
			gate.resolve()
			expect(await Promise.all([first, joined])).toHaveLength(2)
			expect(consumer.asyncCalls).toBe(1)
			expect(consumer.double(3)).toBe(6)
			expect(consumer.double(3)).toBe(6)
			expect(consumer.syncCalls).toBe(1)

			await consumer.explicit('2')
			await consumer.explicit('2')
			expect(consumer.explicitCalls).toBe(1)
			await consumer.cache.scope('decorated').delete('2')
			await consumer.explicit('2')
			expect(consumer.explicitCalls).toBe(2)
			await consumer.pair('admins', '3')
			await consumer.pair('admins', '3')
			expect(consumer.pairCalls).toBe(1)
		})
	})

	it('uses scan-resistant SIEVE eviction', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache
			const sieve = cache.scope('sieve', { maxEntries: 3 }).local
			sieve.set('a', 1)
			sieve.get('a')
			sieve.set('b', 2)
			sieve.set('c', 3)
			sieve.set('d', 4)

			expect(sieve.get('a')).toBe(1)
			expect(sieve.get('b')).toBeUndefined()
		})
	})

	it('validates scopes, capacities, and primitive keys', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache
			expect(() => cache.scope('bad name')).toThrow(/Cache scope/)
			expect(() => cache.scope(`scope\ud800`)).toThrow(/well-formed Unicode/)
			expect(() => cache.scope('valid', { maxEntries: 0 })).toThrow(/maxEntries/)
			await expect(cache.set(Number.NaN, 1)).rejects.toThrow(/finite/)
		})
	})

	it('binds one exact normalized policy to each scope', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache
			const original = cache.scope('policy', {
				ttlMs: 10,
				readPolicy: 'remote-first',
				backendFailure: 'bypass',
			})
			expect(cache.scope('policy')).toBe(original)
			expect(
				cache.scope('policy', {
					ttlMs: 10,
					readPolicy: 'remote-first',
					backendFailure: 'bypass',
				}),
			).toBe(original)
			expect(() => cache.scope('policy', { ttlMs: 11 })).toThrow(CachePolicyConflictError)
			expect(() => cache.scope('unknown', { extra: true } as never)).toThrow(/unknown field/)
			expect(() => cache.scope('nonplain', new (class {})() as never)).toThrow(/plain object/)
		})
	})

	it('encodes bounded typed tuple and record keys without ambiguity', async () => {
		await withHost(async (host) => {
			addEnabled(host, [MemoryCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const cache = host.require(ConsumerA).cache
			await cache.set({ tenant: 'a', id: 1 }, 'record')
			expect(await cache.get({ id: 1, tenant: 'a' })).toBe('record')
			await cache.set(['a', 1], 'tuple')
			await cache.set('a', 'primitive')
			expect(await cache.get(['a', 1])).toBe('tuple')
			expect(await cache.get('a')).toBe('primitive')
			await cache.set(-0, 'negative-zero')
			await cache.set(0, 'zero')
			expect(await cache.get(-0)).toBe('negative-zero')
			expect(await cache.get(0)).toBe('zero')
			await cache.set('\u{1f680}', 'rocket')
			expect(await cache.get('\u{1f680}')).toBe('rocket')
			await cache.set({ ['\u{1f680}']: 'value' }, 'unicode-field')
			expect(await cache.get({ ['\u{1f680}']: 'value' })).toBe('unicode-field')

			await expect(cache.set({ nested: {} } as never, 1)).rejects.toThrow(/primitive/)
			await expect(cache.set('\ud800', 1)).rejects.toThrow(/well-formed Unicode/)
			await expect(cache.set({ ['\ud800']: 'value' }, 1)).rejects.toThrow(/well-formed Unicode/)
			const accessorKey = Object.defineProperty({}, 'id', { get: () => 1, enumerable: true })
			await expect(cache.set(accessorKey as never, 1)).rejects.toThrow(/data propert/)
			await expect(cache.set({ id: 1, [Symbol('x')]: 2 } as never, 1)).rejects.toThrow(/symbol/)
			await expect(
				cache.set(
					Array.from({ length: 17 }, (_, index) => index),
					1,
				),
			).rejects.toThrow(/16/)
			await expect(cache.set('x'.repeat(1_025), 1)).rejects.toThrow(/1024/)
			await expect(cache.set(Number.POSITIVE_INFINITY, 1)).rejects.toThrow(/finite/)
		})
	})

	it('supports required and bypass backend failure policies for getOrLoad only', async () => {
		await withHost(async (host) => {
			addEnabled(host, [TestCacheBackendPlugin, CachePlugin, ConsumerA])
			await host.commit()
			const backend = host.require(TestCacheBackendPlugin)
			const cache = host.require(ConsumerA).cache
			backend.getError = new Error('read unavailable')

			await expect(cache.getOrLoad('required', () => 1)).rejects.toThrow('read unavailable')
			const bypass = cache.scope('bypass', { backendFailure: 'bypass' })
			let loads = 0
			const load = () => {
				loads++
				return 2
			}
			expect(
				await Promise.all([bypass.getOrLoad('read', load), bypass.getOrLoad('read', load)]),
			).toEqual([2, 2])
			expect(loads).toBe(1)
			expect(bypass.stats().backendReadErrors).toBe(1)

			backend.getError = undefined
			backend.setError = new Error('write unavailable')
			expect(await bypass.getOrLoad('write', () => 3)).toBe(3)
			expect(bypass.local.get('write')).toBe(3)
			expect(bypass.stats().backendWriteErrors).toBe(1)
			await expect(bypass.set('explicit', 4)).rejects.toThrow('write unavailable')
			backend.getError = new Error('read unavailable')
			await expect(bypass.get('explicit')).rejects.toThrow('read unavailable')
			await expect(
				bypass.getOrLoad('loader-error', () => Promise.reject(new Error('loader failed'))),
			).rejects.toThrow('loader failed')
		})
	})
})
