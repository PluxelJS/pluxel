import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/plugin-cache'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/plugin-rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/plugin-redis'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/core'
import { S3 } from '@pluxel/plugin-storage'
import { describe, expect, it } from 'vitest'
import {
	createHostConfigRecords,
	hostPlugins,
	createHostRuntimeState,
	redisBackedPlugins,
	s3StorageNode,
} from './catalog'
import { ReportStudioPlugin } from './ReportStudio'

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
		expect(hostPlugins.filter((plugin) => plugin.name === 'ReportStudioPlugin')).toEqual([
			ReportStudioPlugin,
		])
		expect(
			hostPlugins.some((plugin) =>
				/ShowcaseRenderer|ReleaseArchive|PluginEvents|OptionalIntegration/.test(plugin.name),
			),
		).toBe(false)
	})
})
