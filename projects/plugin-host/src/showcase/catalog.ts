import { BotWorkspacePlugin } from '../bot-lab/BotWorkspacePlugin'
import { TelegramBotPlugin, DiscordBotPlugin, WeComBotPlugin } from '../bot-lab/BotSources'
import { VaultAdminPlugin } from '@pluxel/services/plugins'
import { AuthPlugin } from '@pluxel/auth'
import { CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/cache'
import { CanvasPlugin } from '@pluxel/canvas'
import { EChartsPlugin } from '@pluxel/echarts'
import { FontsPlugin } from '@pluxel/fonts'
import { OtelPlugin } from '@pluxel/otel'
import { PackageManagerPlugin } from '@pluxel/package-manager'
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
	BotWorkspacePlugin,
	TelegramBotPlugin,
	DiscordBotPlugin,
	WeComBotPlugin,
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
