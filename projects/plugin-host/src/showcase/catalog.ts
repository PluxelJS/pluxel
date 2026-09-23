import { VaultAdminPlugin } from '@pluxel/vault-admin'
import { AgentToolsPlugin } from '@pluxel/agent-tools'
import { AuthPlugin } from '@pluxel/auth'
import { CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { CanvasPlugin } from '@pluxel/canvas'
import { EChartsPlugin } from '@pluxel/echarts'
import { FontsPlugin } from '@pluxel/fonts'
import { OtelPlugin } from '@pluxel/otel'
import { PackageManagerPlugin } from '@pluxel/package-manager'
import { PiAgentPlugin } from '@pluxel/pi-agent'
import { MemoryRatesBackendPlugin, RatesPlugin } from '@pluxel/rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/redis'
import { S3Plugin } from '@pluxel/storage'
import { TakumiPlugin } from '@pluxel/takumi'
import { WretchPlugin } from '@pluxel/wretch'
import {
	PluginEventsDeclaredConsumer,
	PluginEventsDeclaredProducer,
} from '../demo/PluginEventsDemo'
import {
	PluginOptionalIntegrationConsumer,
	PluginOptionalIntegrationProvider,
} from '../demo/PluginOptionalIntegrationDemo'
import {
	CanvasShowcaseRenderer,
	EChartsShowcaseRenderer,
	ReleaseArchivePlugin,
	ReportStudioPlugin,
	TakumiShowcaseRenderer,
} from './ReportStudio'

export { createHostConfigRecords, createHostRuntimeState, product, s3StorageNode } from './policy'

export const hostPlugins = [
	AgentToolsPlugin,
	PiAgentPlugin,
	PackageManagerPlugin,
	AuthPlugin,
	VaultAdminPlugin,
	MemoryCacheBackendPlugin,
	CachePlugin,
	OtelPlugin,
	MemoryRatesBackendPlugin,
	RatesPlugin,
	RedisPlugin,
	RedisCacheBackendPlugin,
	RedisRatesBackendPlugin,
	S3Plugin,
	WretchPlugin,
	FontsPlugin,
	CanvasPlugin,
	EChartsPlugin,
	TakumiPlugin,
	EChartsShowcaseRenderer,
	TakumiShowcaseRenderer,
	CanvasShowcaseRenderer,
	ReleaseArchivePlugin,
	ReportStudioPlugin,
	PluginEventsDeclaredProducer,
	PluginEventsDeclaredConsumer,
	PluginOptionalIntegrationProvider,
	PluginOptionalIntegrationConsumer,
] as const

export const redisBackedPlugins = Object.freeze([
	RedisPlugin,
	RedisCacheBackendPlugin,
	RedisRatesBackendPlugin,
] as const)
