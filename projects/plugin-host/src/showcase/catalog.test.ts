import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/plugin-cache'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/plugin-rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/plugin-redis'
import { pluginNodeAddressEqual } from '@pluxel/core'
import { S3 } from '@pluxel/plugin-storage'
import { describe, expect, it } from 'vitest'
import {
	createHostConfigRecords,
	hostPlugins,
	createHostPolicy,
	redisBackedPlugins,
	s3StorageNode,
} from './catalog'
import { ReportStudioPlugin } from './ReportStudio'

describe('plugin-host catalog', () => {
	it('selects safe in-memory implementations without auto-starting Redis', () => {
		const state = createHostPolicy()
		const autoStart = state.autoStart ?? []
		for (const plugin of redisBackedPlugins) {
			expect(autoStart.some((node) => pluginNodeAddressEqual(node, plugin.nodeAddress()))).toBe(
				false,
			)
		}
		expect(redisBackedPlugins).toEqual([
			RedisPlugin,
			RedisCacheBackendPlugin,
			RedisRatesBackendPlugin,
		])
		expect(state.providerDefaults).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					token: Cache.definitionAddress(),
					provider: CachePlugin.nodeAddress(),
				}),
				expect.objectContaining({
					token: CacheBackend.definitionAddress(),
					provider: MemoryCacheBackendPlugin.nodeAddress(),
				}),
				expect.objectContaining({
					token: Rates.definitionAddress(),
					provider: RatesPlugin.nodeAddress(),
				}),
				expect.objectContaining({
					token: RatesBackend.definitionAddress(),
					provider: MemoryRatesBackendPlugin.nodeAddress(),
				}),
			]),
		)
	})

	it('prepares one S3 provider with isolated draft and release buckets', () => {
		const state = createHostPolicy()
		expect(state.forks).toBeUndefined()
		expect(
			state.autoStart?.filter((node) => pluginNodeAddressEqual(node, s3StorageNode)),
		).toHaveLength(1)
		expect(state.dependencyOverrides).toBeUndefined()
		expect(state.providerDefaults).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					token: S3.definitionAddress(),
					provider: s3StorageNode,
				}),
			]),
		)

		const records = createHostConfigRecords()
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					owner: s3StorageNode,
					config: expect.objectContaining({
						buckets: [
							expect.objectContaining({
								id: 'drafts',
								backend: expect.objectContaining({ bucketName: 'draft-previews' }),
							}),
							expect.objectContaining({
								id: 'releases',
								backend: expect.objectContaining({ bucketName: 'released-reports' }),
							}),
						],
					}),
				}),
			]),
		)
		expect(hostPlugins.filter((plugin) => plugin === ReportStudioPlugin)).toEqual([
			ReportStudioPlugin,
		])
	})
})
