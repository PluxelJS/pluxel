import {
	parsePluginDefinitionAddress,
	parsePluginNodeAddress,
	type PluginDefinitionAddress,
	type PluginNodeAddress,
	type RuntimeStateSnapshot,
} from '@pluxel/runtime'
import { defineProduct } from '@pluxel/runtime/product'

export const product = defineProduct({
	displayName: 'Pluxel Architecture Lab',
	publisher: 'PluxelJS',
	copyright: 'Runnable architecture showcase and official plugin host',
})

const authPlugin = packageNode('@pluxel/auth', 'AuthPlugin')
const agentToolsPlugin = packageNode('@pluxel/agent-tools', 'AgentToolsPlugin')
const memoryCacheBackendPlugin = packageNode('@pluxel/cache', 'MemoryCacheBackendPlugin')
const cachePlugin = packageNode('@pluxel/cache', 'CachePlugin')
const otelPlugin = packageNode('@pluxel/otel', 'OtelPlugin')
export const packageManagerNode = packageNode('@pluxel/package-manager', 'PackageManagerPlugin')
const memoryRatesBackendPlugin = packageNode('@pluxel/rates', 'MemoryRatesBackendPlugin')
const ratesPlugin = packageNode('@pluxel/rates', 'RatesPlugin')
const s3PluginDefinition = packageDefinition('@pluxel/storage', 'S3Plugin')
const wretchPlugin = packageNode('@pluxel/wretch', 'WretchPlugin')
const fontsPlugin = packageNode('@pluxel/fonts', 'FontsPlugin')
const canvasPlugin = packageNode('@pluxel/canvas', 'CanvasPlugin')
const echartsPlugin = packageNode('@pluxel/echarts', 'EChartsPlugin')
const takumiPlugin = packageNode('@pluxel/takumi', 'TakumiPlugin')

const reportStudioPlugin = sourceNode('src/showcase/ReportStudio.ts', 'ReportStudioPlugin')
const echartsShowcaseRenderer = sourceNode(
	'src/showcase/ReportStudio.ts',
	'EChartsShowcaseRenderer',
)
const showcaseRenderer = sourceDefinition('src/showcase/ReportStudio.ts', 'ShowcaseRenderer')
const eventConsumer = sourceNode('src/demo/PluginEventsDemo.ts', 'PluginEventsDeclaredConsumer')
const optionalProvider = sourceNode(
	'src/demo/PluginOptionalIntegrationDemo.ts',
	'PluginOptionalIntegrationProvider',
)
const optionalConsumer = sourceNode(
	'src/demo/PluginOptionalIntegrationDemo.ts',
	'PluginOptionalIntegrationConsumer',
)

export const s3StorageNode = defaultNode(s3PluginDefinition)

const bootSafeOfficialPlugins = Object.freeze([
	agentToolsPlugin,
	authPlugin,
	memoryCacheBackendPlugin,
	cachePlugin,
	otelPlugin,
	memoryRatesBackendPlugin,
	ratesPlugin,
	wretchPlugin,
	fontsPlugin,
	canvasPlugin,
	echartsPlugin,
	takumiPlugin,
])

export function createHostRuntimeState(dynamic: boolean): Partial<RuntimeStateSnapshot> {
	return {
		autoStart: [
			...bootSafeOfficialPlugins,
			...(dynamic ? [packageManagerNode] : []),
			reportStudioPlugin,
			eventConsumer,
			optionalProvider,
			optionalConsumer,
			s3StorageNode,
		],
		providerDefaults: [
			providerDefault(packageDefinition('@pluxel/cache', 'Cache'), cachePlugin),
			providerDefault(packageDefinition('@pluxel/cache', 'CacheBackend'), memoryCacheBackendPlugin),
			providerDefault(packageDefinition('@pluxel/rates', 'Rates'), ratesPlugin),
			providerDefault(packageDefinition('@pluxel/rates', 'RatesBackend'), memoryRatesBackendPlugin),
			providerDefault(packageDefinition('@pluxel/storage', 'S3'), defaultNode(s3PluginDefinition)),
			providerDefault(showcaseRenderer, echartsShowcaseRenderer),
		],
	}
}

export function createHostConfigRecords(localStorageRoot = '.pluxel/showcase/s3') {
	return [
		{
			owner: otelPlugin,
			config: { otlp: [], prometheus: { path: '/showcase/metrics' } },
		},
		{
			owner: s3StorageNode,
			config: {
				buckets: [
					{
						id: 'drafts',
						backend: {
							type: 'local',
							rootDir: localStorageRoot,
							bucketName: 'draft-previews',
							syncWrites: true,
						},
					},
					{
						id: 'releases',
						backend: {
							type: 'local',
							rootDir: localStorageRoot,
							bucketName: 'released-reports',
							syncWrites: true,
						},
					},
				],
			},
		},
	] as const
}

function packageDefinition(packageName: string, exportName: string): PluginDefinitionAddress {
	return parsePluginDefinitionAddress({
		entry: { kind: 'package-root', packageName },
		exportName,
	})
}

function sourceDefinition(path: string, exportName: string): PluginDefinitionAddress {
	return parsePluginDefinitionAddress({
		entry: { kind: 'source-entry', sourceSpace: 'app', path },
		exportName,
	})
}

function packageNode(packageName: string, exportName: string): PluginNodeAddress {
	return defaultNode(packageDefinition(packageName, exportName))
}

function sourceNode(path: string, exportName: string): PluginNodeAddress {
	return defaultNode(sourceDefinition(path, exportName))
}

function defaultNode(definition: PluginDefinitionAddress): PluginNodeAddress {
	return parsePluginNodeAddress({ definition, variant: 'default' })
}

function providerDefault(
	token: PluginDefinitionAddress,
	provider: PluginNodeAddress,
): Readonly<{ token: PluginDefinitionAddress; provider: PluginNodeAddress }> {
	return Object.freeze({ token, provider })
}
