import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { PackageManagerPlugin } from '@pluxel/package-manager'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'
import {
	pluginDefinitionAddressEqual,
	pluginDefinitionAddressOf,
	pluginNodeAddressEqual,
	pluginNodeAddressOf,
} from '@pluxel/runtime'
import { S3, S3Plugin } from '@pluxel/storage'
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
	draftsStorageNode,
	focusedDemoPlugins,
	officialDynamicPlugins,
	officialStaticPlugins,
	redisBackedPlugins,
	releasesStorageNode,
	staticHostPlugins,
} from './catalog'
import { EChartsShowcaseRenderer, ReportStudioPlugin, ShowcaseRenderer } from './ReportStudio'

describe('plugin-host catalog', () => {
	it('loads every official concrete plugin and keeps Package Manager dynamic-only', () => {
		expect(officialStaticPlugins).toHaveLength(16)
		expect(officialDynamicPlugins).toHaveLength(17)
		expect(new Set(officialDynamicPlugins).size).toBe(17)
		expect(officialStaticPlugins).toContain(AgentToolsPlugin)
		expect(officialStaticPlugins).not.toContain(PackageManagerPlugin)
		expect(officialDynamicPlugins).toContain(PackageManagerPlugin)
		expect(staticHostPlugins).not.toContain(PackageManagerPlugin)
		expect(staticHostPlugins).toHaveLength(25)
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

	it('prepares isolated draft/release S3 forks and consumer overrides', () => {
		const state = createHostRuntimeState(false)
		expect(state.forks).toEqual([
			{
				definition: pluginDefinitionAddressOf(S3Plugin),
				forkIds: ['drafts', 'releases'],
			},
		])
		expect(state.autoStart?.some((node) => pluginNodeAddressEqual(node, draftsStorageNode))).toBe(
			true,
		)
		expect(state.autoStart?.some((node) => pluginNodeAddressEqual(node, releasesStorageNode))).toBe(
			true,
		)
		expect(state.dependencyOverrides).toHaveLength(2)
		for (const binding of state.dependencyOverrides ?? []) {
			expect(
				pluginDefinitionAddressEqual(binding.requirementAddress, pluginDefinitionAddressOf(S3)),
			).toBe(true)
		}

		const records = createHostConfigRecords()
		expect(records).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					owner: draftsStorageNode,
					config: expect.objectContaining({
						backend: expect.objectContaining({ bucketName: 'draft-previews' }),
					}),
				}),
				expect.objectContaining({
					owner: releasesStorageNode,
					config: expect.objectContaining({
						backend: expect.objectContaining({ bucketName: 'released-reports' }),
					}),
				}),
			]),
		)
		expect(pluginNodeAddressOf(ReportStudioPlugin)).toBeDefined()
	})
})
