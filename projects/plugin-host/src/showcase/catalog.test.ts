import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { PackageManagerPlugin } from '@pluxel/package-manager'
import { PiAgentPlugin } from '@pluxel/pi-agent'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'
import {
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/runtime'
import { S3 } from '@pluxel/storage'
import { describe, expect, it } from 'vitest'
import {
	PluginEventsDeclaredConsumer,
	PluginEventsDeclaredProducer,
} from '../demo/PluginEventsDemo'
import {
	PluginOptionalIntegrationConsumer,
	PluginOptionalIntegrationProvider,
} from '../demo/PluginOptionalIntegrationDemo'
import {
	createHostConfigRecords,
	createHostRuntimeState,
	focusedDemoPlugins,
	officialDynamicPlugins,
	officialStaticPlugins,
	redisBackedPlugins,
	s3StorageNode,
	staticHostPlugins,
} from './catalog'
import { EChartsShowcaseRenderer, ReportStudioPlugin, ShowcaseRenderer } from './ReportStudio'

describe('plugin-host catalog', () => {
	it('loads every official concrete plugin and keeps Package Manager dynamic-only', () => {
		expect(officialStaticPlugins).toHaveLength(17)
		expect(officialDynamicPlugins).toHaveLength(18)
		expect(new Set(officialDynamicPlugins).size).toBe(18)
		expect(officialStaticPlugins).toContain(AgentToolsPlugin)
		expect(officialStaticPlugins).toContain(PiAgentPlugin)
		expect(officialStaticPlugins).not.toContain(PackageManagerPlugin)
		expect(officialDynamicPlugins).toContain(PackageManagerPlugin)
		expect(staticHostPlugins).not.toContain(PackageManagerPlugin)
		expect(staticHostPlugins).toHaveLength(26)
	})

	it('keeps only demos that add event and optional lifecycle semantics', () => {
		expect(focusedDemoPlugins).toEqual([
			PluginEventsDeclaredProducer,
			PluginEventsDeclaredConsumer,
			PluginOptionalIntegrationProvider,
			PluginOptionalIntegrationConsumer,
		])
	})

	it('selects safe in-memory implementations without auto-starting Redis', () => {
		const state = createHostRuntimeState(false)
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

	it('keeps Pi Agent available but stopped until an assignment and model are intentional', () => {
		const autoStart = createHostRuntimeState(false).autoStart ?? []
		expect(
			autoStart.some((node) => pluginNodeAddressEqual(node, pluginNodeAddressOf(PiAgentPlugin))),
		).toBe(false)
	})

	it('prepares one S3 provider with isolated draft and release buckets', () => {
		const state = createHostRuntimeState(false)
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
