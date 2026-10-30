import * as nativeFs from 'node:fs'
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pluginNodeAddressOf, BasePlugin, Plugin } from '@pluxel/core'
import { createTestHost } from '@pluxel/test'
import { standardServices } from '@pluxel/services'
import { InMemory, Passthrough, type FsServiceConfig } from '@pluxel/services/fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Cache, CachePlugin, MemoryCacheBackendPlugin } from '../src/index.ts'

const directories: string[] = []
afterEach(async () => {
	await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

@Plugin()
class PersistentCacheConsumer extends BasePlugin {
	constructor(readonly cache: Cache) {
		super()
	}
}

async function durableStorage() {
	const prefix = await mkdtemp(join(tmpdir(), 'pluxel-cache-fs-'))
	directories.push(prefix)
	return { backend: Passthrough, fs: nativeFs, prefix } satisfies FsServiceConfig
}

async function snapshotPath(prefix: string) {
	const owners = await readdir(join(prefix, 'plugins'))
	expect(owners).toHaveLength(1)
	return join(prefix, 'plugins', owners[0]!, 'memory-backend.snapshot')
}

async function withPersistentCache(
	storage: FsServiceConfig,
	fn: (cache: Cache) => Promise<void>,
	options: {
		mode?: 'best-effort' | 'durable'
		maxEntries?: number
		flushIntervalMs?: number
	} = {},
): Promise<void> {
	await using host = await createTestHost({ services: standardServices({ fs: storage }) })
	const persistence = {
		mode: options.mode ?? 'durable',
		...(options.flushIntervalMs === undefined ? {} : { flushIntervalMs: options.flushIntervalMs }),
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

describe('MemoryCacheBackendPlugin persistence', () => {
	it('restores structured values with their absolute expiry after reopening a real backend', async () => {
		vi.useFakeTimers()
		try {
			vi.setSystemTime(new Date('2026-07-18T00:00:00.000Z'))
			const storage = await durableStorage()
			await withPersistentCache(storage, async (cache) => {
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
			await withPersistentCache(storage, async (cache) => {
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
		const storage = await durableStorage()
		await withPersistentCache(storage, async (cache) => {
			await cache.set('a', 1, { ttlMs: 0 })
			await cache.set('b', 2, { ttlMs: 0 })
			await cache.set('c', 3, { ttlMs: 0 })
		})
		await withPersistentCache(
			storage,
			async (cache) => {
				const values = await Promise.all([cache.get('a'), cache.get('b'), cache.get('c')])
				expect(values.filter((value) => value !== undefined)).toHaveLength(2)
			},
			{ maxEntries: 2 },
		)
	})

	it('requires a serializable value when snapshot persistence is writable', async () => {
		await withPersistentCache(await durableStorage(), async (cache) => {
			await expect(cache.set('function', (): void => undefined)).rejects.toThrow(/serializable/)
		})
	})

	it('writes a newer revision when delete races an in-flight atomic replacement', async () => {
		const storage = await durableStorage()
		let releaseFirstWrite!: () => void
		const firstWriteGate = new Promise<void>((resolve) => {
			releaseFirstWrite = resolve
		})
		let snapshotWrites = 0
		const instrumented = {
			...storage,
			fs: {
				...nativeFs,
				promises: {
					...nativeFs.promises,
					async rename(from: nativeFs.PathLike, to: nativeFs.PathLike) {
						if (String(to).endsWith('/memory-backend.snapshot')) {
							snapshotWrites++
							if (snapshotWrites === 1) await firstWriteGate
						}
						await nativeFs.promises.rename(from, to)
					},
				},
			},
		}
		try {
			await withPersistentCache(
				instrumented,
				async (cache) => {
					await cache.set('racing', 'stale', { ttlMs: 0 })
					await vi.waitFor(() => expect(snapshotWrites).toBe(1))
					await cache.delete('racing')
					releaseFirstWrite()
					await vi.waitFor(() => expect(snapshotWrites).toBe(2))
				},
				{ flushIntervalMs: 0 },
			)
		} finally {
			releaseFirstWrite()
		}
		await withPersistentCache(storage, async (cache) => {
			expect(await cache.get('racing')).toBeUndefined()
		})
	})

	it('fails lifecycle honestly when durable storage is unavailable', async () => {
		await using host = await createTestHost({
			services: standardServices({ fs: { backend: InMemory } }),
		})
		const failure = await host.commitExpectFail((change) => {
			change.start(MemoryCacheBackendPlugin, {
				initialConfig: { maxEntries: 10, persistence: { mode: 'durable', flushIntervalMs: 1_000 } },
			})
		})
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				plugin: pluginNodeAddressOf(MemoryCacheBackendPlugin),
				kind: 'start-failed',
				message: expect.stringMatching(/durable|ephemeral/i),
			}),
		)
	})

	it('reports durable snapshot read failures without misclassifying them as corruption', async () => {
		const storage = await durableStorage()
		await withPersistentCache(storage, async (cache) => {
			await cache.set('seed', true)
		})
		const instrumented = {
			...storage,
			fs: {
				...nativeFs,
				promises: {
					...nativeFs.promises,
					async open(...args: Parameters<typeof nativeFs.promises.open>) {
						if (String(args[0]).endsWith('/memory-backend.snapshot'))
							throw new Error('storage unavailable')
						return nativeFs.promises.open(...args)
					},
				},
			},
		}
		await using host = await createTestHost({ services: standardServices({ fs: instrumented }) })
		const failure = await host.commitExpectFail((change) => {
			change.start(MemoryCacheBackendPlugin, {
				initialConfig: { maxEntries: 10, persistence: { mode: 'durable', flushIntervalMs: 1_000 } },
			})
		})
		expect(failure.lifecycleReport.issues).toContainEqual(
			expect.objectContaining({
				plugin: pluginNodeAddressOf(MemoryCacheBackendPlugin),
				kind: 'start-failed',
				message: expect.stringContaining('could not be restored'),
			}),
		)
	})

	it('starts empty and replaces a corrupt best-effort snapshot', async () => {
		const storage = await durableStorage()
		await withPersistentCache(storage, async (cache) => {
			await cache.set('seed', true)
		})
		await writeFile(await snapshotPath(storage.prefix), new Uint8Array([1, 2, 3]))
		await withPersistentCache(
			storage,
			async (cache) => {
				expect(await cache.get('missing')).toBeUndefined()
				await cache.set('healthy', true, { ttlMs: 0 })
			},
			{ mode: 'best-effort' },
		)
		await withPersistentCache(
			storage,
			async (cache) => {
				expect(await cache.get('healthy')).toBe(true)
			},
			{ mode: 'best-effort' },
		)
	})

	it('restores a readonly best-effort snapshot without saving later mutations', async () => {
		const storage = await durableStorage()
		await withPersistentCache(storage, async (cache) => {
			await cache.set('seed', true, { ttlMs: 0 })
		})
		await withPersistentCache(
			{ ...storage, readOnly: true },
			async (cache) => {
				expect(await cache.get('seed')).toBe(true)
				await cache.set('unsaved', true, { ttlMs: 0 })
			},
			{ mode: 'best-effort' },
		)
		await withPersistentCache(storage, async (cache) => {
			expect(await cache.get('seed')).toBe(true)
			expect(await cache.get('unsaved')).toBeUndefined()
		})
	})
})
