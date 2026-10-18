import { BotWorkspacePlugin } from '../bot-lab/BotWorkspacePlugin'
import { TelegramBotPlugin, DiscordBotPlugin, WeComBotPlugin } from '../bot-lab/BotSources'
import { VaultAdminPlugin } from '@pluxel/services/plugins'
import { AuthPlugin } from '@pluxel/plugin-auth'
import { CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/plugin-cache'
import { CanvasPlugin } from '@pluxel/plugin-canvas'
import { EChartsPlugin } from '@pluxel/plugin-echarts'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { OtelPlugin } from '@pluxel/plugin-otel'
import { PackageManagerPlugin } from '@pluxel/plugin-package-manager'
import { MemoryRatesBackendPlugin, RatesPlugin } from '@pluxel/plugin-rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/plugin-redis'
import { S3Plugin } from '@pluxel/plugin-storage'
import { TakumiPlugin } from '@pluxel/plugin-takumi'
import { TakumiMarkdownPlugin } from '@pluxel/plugin-takumi-markdown'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { WretchPlugin } from '@pluxel/plugin-wretch'
import { ReportStudioPlugin } from './ReportStudio'

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
	TakumiMarkdownPlugin,
	TypstPlugin,
	ReportStudioPlugin,
] as const

export const redisBackedPlugins = Object.freeze([
	RedisPlugin,
	RedisCacheBackendPlugin,
	RedisRatesBackendPlugin,
] as const)
