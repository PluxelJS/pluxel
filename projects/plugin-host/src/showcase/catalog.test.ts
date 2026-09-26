import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { S3 } from '@pluxel/storage'
import { describe, expect, it } from 'vitest'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	redisBackedPlugins,
	s3StorageNode,
} from './catalog'
import { EChartsShowcaseRenderer, ReportStudioPlugin, ShowcaseRenderer } from './ReportStudio'

describe('plugin-host catalog', () => {
	it('selects safe in-memory implementations without auto-starting Redis', () => {
		const state = createHostRuntimeState()
		const autoStart = state.autoStart ?? []
		for (const plugin of redisBackedPlugins) {
			expect(
				autoStart.some((node) => pluginNodeAddressEqual(node, pluginNodeAddressOf(plugin))),
			).toBe(false)
		}
		expect(redisBackedPlugins).toEqual([
			RedisPlugin,
			RedisCacheBackendPlugin,
			RedisRatesBackendPlugin,
		])
		expect(state.providerDefaults).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					token: pluginDefinitionAddressOf(Cache),
					provider: pluginNodeAddressOf(CachePlugin),
				}),
				expect.objectContaining({
					token: pluginDefinitionAddressOf(CacheBackend),
					provider: pluginNodeAddressOf(MemoryCacheBackendPlugin),
				}),
				expect.objectContaining({
					token: pluginDefinitionAddressOf(Rates),
					provider: pluginNodeAddressOf(RatesPlugin),
				}),
				expect.objectContaining({
					token: pluginDefinitionAddressOf(RatesBackend),
					provider: pluginNodeAddressOf(MemoryRatesBackendPlugin),
				}),
				expect.objectContaining({
					token: pluginDefinitionAddressOf(ShowcaseRenderer),
					provider: pluginNodeAddressOf(EChartsShowcaseRenderer),
				}),
			]),
		)
	})

	it('prepares one S3 provider with isolated draft and release buckets', () => {
		const state = createHostRuntimeState()
		expect(state.forks).toBeUndefined()
		expect(
			state.autoStart?.filter((node) => pluginNodeAddressEqual(node, s3StorageNode)),
		).toHaveLength(1)
		expect(state.dependencyOverrides).toBeUndefined()
		expect(state.providerDefaults).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					token: pluginDefinitionAddressOf(S3),
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
		expect(pluginNodeAddressOf(ReportStudioPlugin)).toBeDefined()
	})
})
