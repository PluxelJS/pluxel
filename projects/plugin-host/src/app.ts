import * as nativeFs from 'node:fs'
import { defineHostApplication, type HostApplication } from '@pluxel/host'
import { resolveHostEnv } from '@pluxel/host/environment'
import { servicesPreset } from '@pluxel/services/preset'
import { listenElysia } from '@pluxel/services/elysia/node'
import { Passthrough } from '@pluxel/core/fs'
import { defineProduct } from '@pluxel/services/management/product'
import { resolve } from 'pathe'
import { BotWorkspacePlugin } from './bot-lab/BotWorkspacePlugin'
import { TelegramBotPlugin, DiscordBotPlugin, WeComBotPlugin } from './bot-lab/BotSources'
import { VaultAdminPlugin } from '@pluxel/services/plugins'
import { AuthPlugin } from '@pluxel/plugin-auth'
import { Cache, CacheBackend, CachePlugin, MemoryCacheBackendPlugin } from '@pluxel/plugin-cache'
import { CanvasPlugin } from '@pluxel/plugin-canvas'
import { EChartsPlugin } from '@pluxel/plugin-echarts'
import { FontsPlugin } from '@pluxel/plugin-fonts'
import { OtelPlugin } from '@pluxel/plugin-otel'
import { PackageManagerPlugin } from '@pluxel/plugin-package-manager'
import { MemoryRatesBackendPlugin, Rates, RatesBackend, RatesPlugin } from '@pluxel/plugin-rates'
import { RedisCacheBackendPlugin, RedisPlugin, RedisRatesBackendPlugin } from '@pluxel/plugin-redis'
import { S3, S3Plugin } from '@pluxel/plugin-storage'
import { TakumiPlugin } from '@pluxel/plugin-takumi'
import { TakumiMarkdownPlugin } from '@pluxel/plugin-takumi-markdown'
import { TypstPlugin } from '@pluxel/plugin-typst'
import { WretchPlugin } from '@pluxel/plugin-wretch'
import { ReportStudioPlugin } from './showcase/ReportStudio'

export const product = defineProduct({
	displayName: 'Pluxel Architecture Lab',
	publisher: 'PluxelJS',
	copyright: 'Runnable architecture showcase and official plugin host',
})

export default defineHostApplication(async (startup): Promise<HostApplication> => {
	const environment = resolveHostEnv(startup.env)
	const dataRoot = resolve(startup.deployment?.root ?? startup.root, environment.dataRoot)
	const managedPackagesRoot = resolve(dataRoot, 'managed-plugins')
	const prefix = resolve(dataRoot, 'fs')
	const localStorageRoot = resolve(dataRoot, 'showcase/s3')
	const workbench = environment.workbench ?? startup.deployment?.variant !== 'headless'
	await nativeFs.promises.mkdir(prefix, { recursive: true })
	return {
		name: 'pluxel-architecture-lab',
		plugins: [
			{ plugin: BotWorkspacePlugin, autoStart: true },
			{ plugin: TelegramBotPlugin, autoStart: true },
			{ plugin: DiscordBotPlugin, autoStart: true },
			{ plugin: WeComBotPlugin, autoStart: true },
			{ plugin: PackageManagerPlugin, autoStart: true, config: { rootDir: managedPackagesRoot } },
			{ plugin: AuthPlugin, autoStart: true },
			{ plugin: VaultAdminPlugin, autoStart: true },
			{ plugin: MemoryCacheBackendPlugin, autoStart: true },
			{ plugin: CachePlugin, autoStart: true },
			{
				plugin: OtelPlugin,
				autoStart: true,
				config: { otlp: [], prometheus: { path: '/showcase/metrics' } },
			},
			{ plugin: MemoryRatesBackendPlugin, autoStart: true },
			{ plugin: RatesPlugin, autoStart: true },
			{ plugin: RedisPlugin },
			{ plugin: RedisCacheBackendPlugin },
			{ plugin: RedisRatesBackendPlugin },
			{
				plugin: S3Plugin,
				autoStart: true,
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
			{ plugin: WretchPlugin, autoStart: true },
			{ plugin: FontsPlugin, autoStart: true },
			{ plugin: CanvasPlugin, autoStart: true },
			{ plugin: EChartsPlugin, autoStart: true },
			{ plugin: TakumiPlugin, autoStart: true },
			{ plugin: TakumiMarkdownPlugin, autoStart: true },
			{ plugin: TypstPlugin, autoStart: true },
			{ plugin: ReportStudioPlugin, autoStart: true },
		],
		sources: [
			{
				directory: resolve(managedPackagesRoot, 'entries'),
				include: ['*.mjs'],
			},
		],
		services: await servicesPreset(startup, {
			product,
			workbench: workbench
				? {
						service: {
							initialShortcuts: [
								{ target: PackageManagerPlugin.nodeAddress(), entryKey: 'marketplace' },
							],
						},
					}
				: false,
		}),
		async launch({ host }) {
			await listenElysia(host, {
				hostname: environment.hostBind,
				port: environment.hostPort,
				publicOrigin: environment.publicOrigin,
				publicDir: resolve(startup.deployment?.root ?? startup.root, 'public'),
			})
		},
		config: { mode: 'saved-first' },
		policy: {
			execution: { startTimeoutMs: 30_000 },
			modes: { autoStart: 'saved-first', providerDefaults: 'saved-first' },
			providerDefaults: [
				{ token: Cache.address(), provider: CachePlugin.nodeAddress() },
				{ token: CacheBackend.address(), provider: MemoryCacheBackendPlugin.nodeAddress() },
				{ token: Rates.address(), provider: RatesPlugin.nodeAddress() },
				{ token: RatesBackend.address(), provider: MemoryRatesBackendPlugin.nodeAddress() },
				{ token: S3.address(), provider: S3Plugin.nodeAddress() },
			],
		},
		coreConfig: {
			vault: { deployIdentity: startup.env.PLUXEL_VAULT_DEPLOY_IDENTITY },
			logtape: {},
			zenfs: {
				mounts: { '/': { backend: Passthrough, fs: nativeFs, prefix } },
				durableMounts: ['/'],
			},
		},
	}
})
