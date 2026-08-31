import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'pathe'
import type { ViteDevServer } from 'vite'

import type { Context, PluginConstructor } from '@pluxel/core'
import { requireConfigService } from '@pluxel/core/internal'
import {
	createContextPluginLogPolicyStore,
	createNodeWorkspaceFsBackend,
	createRuntimeRootContext,
	createRuntimeLogging,
	installRuntimeRouteCapabilities,
	isWorkbenchEnabled,
	prepareRuntimeRootContext,
	readRuntimeRouteCapabilities,
	requireRuntimeStateStore,
	resolvePackagedNodeModule,
	resolveRuntimeStoragePaths,
	withPluginConfigEnvironment,
	type RuntimeHostConfig,
	type RuntimeLogging,
	type RuntimeLoggingInput,
	type RuntimeStoragePaths,
} from '@pluxel/runtime/internal'
import { createWorkspacePersistenceBackend } from '@pluxel/runtime'
import {
	describePluxelPlatform,
	env as runtimeEnvironment,
	hostEnv as defaultHostEnvironment,
	resolveHostEnv,
} from '@pluxel/runtime/environment'
import type { ProductDescriptor } from '@pluxel/runtime/product'
import { attachPluginArtifactCompiler } from '@pluxel/runtime-dev/workbench'
import type { DynamicRuntimeStorageOptions } from '../config'

import {
	diagnoseWorkspace,
	nodeLoaderHmrWorkspaceFs,
	resolveDefaultLoaderHmrConfigPath,
	type LoaderHmrWorkspaceFs,
	type WorkspaceSnapshot,
} from './diagnose'
import {
	attachLoaderHmrWorkbenchProducerPublisher,
	LoaderHmrService,
	type LoaderHmrConfig,
} from './engine/LoaderHmrService'
export { configureLoaderHmrWorkbenchProducerSource } from './engine/LoaderHmrService'
import { applyLoaderHmrEnvOverrides } from './hmr-env'
import { assertLoaderHmrWorkspace, type LoaderHmrWorkspaceSnapshot } from './snapshot'
import { resolveDynamicPluginSources, type DynamicPluginSource } from '../sources'
import { createDynamicRouteContextCapabilities, requireLoaderService } from '../context-plan'

const nodeHostFs = nodeLoaderHmrWorkspaceFs

export type LoaderHmrHostStorageOptions = DynamicRuntimeStorageOptions

export type LoaderHmrHostOptions<
	TSnapshot extends LoaderHmrWorkspaceSnapshot = LoaderHmrWorkspaceSnapshot,
> = {
	root?: string
	fs?: LoaderHmrWorkspaceFs
	debug?: readonly string[]
	snapshot: TSnapshot
	warnings?: readonly string[]
	snapshotPatch?: (snapshot: TSnapshot) => TSnapshot
	plugins?: readonly PluginConstructor[]
	printUrls?: boolean
	logging?: false | RuntimeLoggingInput
	logsDir?: string
	logFile?: string
	storage?: LoaderHmrHostStorageOptions
	configService?: RuntimeHostConfig['configService']
	runtimeState?: RuntimeHostConfig['runtimeState']
	persistence?: RuntimeHostConfig['persistence']
	database?: RuntimeHostConfig['database']
	workers?: RuntimeHostConfig['workers']
	management?: RuntimeHostConfig['management']
	workbench?: RuntimeHostConfig['workbench']
	vault?: RuntimeHostConfig['vault']
}

export type PlannedLoaderHmrHost<
	TSnapshot extends LoaderHmrWorkspaceSnapshot = LoaderHmrWorkspaceSnapshot,
> = {
	root: string
	fs: LoaderHmrWorkspaceFs
	debug: readonly string[]
	snapshot: TSnapshot
	warnings: readonly string[]
	plugins?: readonly PluginConstructor[]
	fixedModuleId: string
	dynamicSources: readonly DynamicPluginSource[]
	printUrls?: boolean
	logging?: false | RuntimeLoggingInput
	runtimeStorage: RuntimeStoragePaths
	runtimeConfig: RuntimeHostConfig
}

export type BootedLoaderHmrHost = {
	root: string
	logsDir: string
	ctx: import('@pluxel/core').Context
	hmr: LoaderHmrService
	stop(): Promise<void>
}

export type BootLoaderHmrHostOptions = {
	viteServer?: ViteDevServer
	product?: ProductDescriptor | null
	/** @internal Route-owned Workbench asset selection. */
	workbenchAssets?: 'source' | 'built'
	/** @internal Route-owned Workbench remote cache directory. */
	workbenchArtifactCacheDir?: string
}

export type LoaderHmrHostConfigInput = Omit<
	LoaderHmrHostOptions<WorkspaceSnapshot>,
	'snapshot' | 'warnings'
> & {
	configPath?: string
	profile?: string
	env?: Record<string, string | undefined>
	omitPackages?: string[]
	sources?: readonly DynamicPluginSource[]
}

type PlanLoaderHmrHostInternalOptions = {
	configModuleId?: string
	dynamicSources?: readonly DynamicPluginSource[]
}

function planRuntimeStorage(
	root: string,
	storage: LoaderHmrHostStorageOptions | undefined,
	logs: Pick<LoaderHmrHostOptions, 'logsDir' | 'logFile'>,
): {
	runtimeStorage: RuntimeStoragePaths
} {
	const runtimeStorage = resolveRuntimeStoragePaths(root, {
		persistenceDir: storage?.persistenceDir ?? join(defaultHostEnvironment.dataRoot, 'persistence'),
		...(logs.logsDir ? { logsDir: logs.logsDir } : {}),
		...(logs.logFile ? { logFile: logs.logFile } : {}),
	})

	return {
		runtimeStorage,
	}
}

export function planLoaderHmrHost<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	opts: LoaderHmrHostOptions<TSnapshot>,
	internal: PlanLoaderHmrHostInternalOptions = {},
): PlannedLoaderHmrHost<TSnapshot> {
	const root = resolve(opts.root ?? process.cwd())
	const fs = opts.fs ?? nodeHostFs

	let snapshot = opts.snapshot
	if (!snapshot) {
		throw new Error(
			'[loader-hmr-host] snapshot is required (compute it in your caller, e.g. via @pluxel/runtime-dynamic/hmr)',
		)
	}
	if (opts.snapshotPatch) snapshot = opts.snapshotPatch(snapshot)
	assertLoaderHmrWorkspace(snapshot)

	const { runtimeStorage } = planRuntimeStorage(root, opts.storage, {
		logsDir: opts.logsDir,
		logFile: opts.logFile,
	})

	return {
		root,
		fs,
		debug: opts.debug ?? ['hmr:*', 'bundler', 'workbench:compile'],
		snapshot,
		warnings: opts.warnings ?? [],
		plugins: opts.plugins,
		fixedModuleId: `pluxel:fixed:${normalizeFixedModuleId(internal.configModuleId ?? resolve(root, 'pluxel.dynamic.ts'))}`,
		dynamicSources: internal.dynamicSources ?? [],
		printUrls: opts.printUrls,
		logging: opts.logging,
		runtimeStorage,
		runtimeConfig: compactRuntimeHostConfig({
			configService: opts.configService,
			runtimeState: opts.runtimeState,
			persistence: opts.persistence,
			database: opts.database,
			workers: opts.workers,
			management: opts.management,
			workbench: opts.workbench,
			vault: opts.vault,
			debug: opts.debug,
		}),
	}
}

export async function planLoaderHmrHostFromConfig(
	opts: LoaderHmrHostConfigInput,
	internal: PlanLoaderHmrHostInternalOptions = {},
): Promise<PlannedLoaderHmrHost<WorkspaceSnapshot>> {
	const {
		configPath,
		profile,
		env: envOverrides,
		omitPackages,
		configService,
		sources,
		...hostOpts
	} = opts

	const rootDir = resolve(process.cwd(), hostOpts.root ?? '.')
	const configPathAbs = (() => {
		if (configPath) return isAbsolute(configPath) ? configPath : resolve(rootDir, configPath)
		return resolveDefaultLoaderHmrConfigPath(rootDir)
	})()
	const env: Record<string, string | undefined> = {
		...runtimeEnvironment,
		...(profile ? { PLUXEL_HMR_PROFILE: profile } : {}),
		...envOverrides,
	}
	const pluxelEnvironment = resolveHostEnv(env)
	const resolvedHostOptions: typeof hostOpts = {
		...hostOpts,
		...(env.PLUXEL_DATA_ROOT !== undefined &&
		(hostOpts.persistence === undefined || typeof hostOpts.persistence === 'string')
			? {
					storage: {
						...hostOpts.storage,
						persistenceDir: join(pluxelEnvironment.dataRoot, 'persistence'),
					},
					...(typeof hostOpts.persistence === 'string' ? { persistence: undefined } : {}),
				}
			: {}),
		...(pluxelEnvironment.workbench === undefined
			? {}
			: {
					workbench: pluxelEnvironment.workbench
						? {
								...(typeof hostOpts.workbench === 'object' ? hostOpts.workbench : {}),
								enabled: true,
							}
						: false,
				}),
	}

	const diagnosed = await diagnoseWorkspace({
		rootDir,
		configPath: configPathAbs,
		env,
		omitPackages,
		fs: hostOpts.fs,
	})
	if (diagnosed.ok === false) throw new Error(diagnosed.errors.join('\n'))
	const dynamicSources = await resolveDynamicPluginSources(rootDir, sources)
	const snapshot: WorkspaceSnapshot = {
		...diagnosed.snapshot,
		enabledEntries: uniqueStrings([
			...diagnosed.snapshot.enabledEntries,
			...dynamicSources.entries,
		]),
		includedEntries: uniqueStrings([
			...diagnosed.snapshot.includedEntries,
			...dynamicSources.entries,
		]),
		watchRoots: uniqueStrings([...diagnosed.snapshot.watchRoots, ...dynamicSources.roots]),
		includeGlobs: uniqueStrings([
			...diagnosed.snapshot.includeGlobs,
			...dynamicSources.includeGlobs,
		]),
	}

	return planLoaderHmrHost(
		{
			...resolvedHostOptions,
			root: rootDir,
			snapshot,
			warnings: diagnosed.warnings,
			configService: withPluginConfigEnvironment(configService, env),
		},
		{
			configModuleId: internal.configModuleId,
			dynamicSources: dynamicSources.declarations,
		},
	)
}

function normalizeFixedModuleId(value: string): string {
	return resolve(value).replaceAll('\\', '/')
}

function uniqueStrings(values: readonly string[]): string[] {
	return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

export async function bootPlannedLoaderHmrHost<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	plan: PlannedLoaderHmrHost<TSnapshot>,
	options: BootLoaderHmrHostOptions = {},
): Promise<BootedLoaderHmrHost> {
	await plan.fs.promises.mkdir(plan.runtimeStorage.logsDir, { recursive: true })
	const logging = createRuntimeLogging(resolveLoaderRuntimeLoggingInput(plan))
	await logging.install()
	let ctx: Context | undefined

	try {
		const runtimeFsBackend = createNodeWorkspaceFsBackend(plan.fs)
		const defaultConfig: RuntimeHostConfig = {
			name: plan.snapshot.activeProfile,
			debug: plan.debug,
			logger: logging.contextBinding,
			persistence: {
				mode: 'custom',
				backend: createWorkspacePersistenceBackend(runtimeFsBackend, {
					root: plan.runtimeStorage.persistenceDir,
				}),
			},
			nodeModuleArtifactResolver: resolvePackagedNodeModule,
		}
		const runtimeConfig = mergeRuntimeHostConfig(defaultConfig, plan.runtimeConfig)
		if (isWorkbenchEnabled(runtimeConfig.workbench)) {
			runtimeConfig.http = withWorkbenchHttpConfig(
				runtimeConfig.http,
				options.workbenchAssets ?? 'source',
			)
		}
		const runtimeInternal = isWorkbenchEnabled(runtimeConfig.workbench)
			? await import('@pluxel/runtime/internal')
			: undefined
		const workbench = runtimeInternal
			? { createBackend: runtimeInternal.createWorkbenchBackend }
			: undefined
		ctx = createRuntimeRootContext(runtimeConfig, {
			logging,
			product: options.product ?? null,
			routeContextCapabilities: createDynamicRouteContextCapabilities({
				workspaceRoot: plan.root,
				fs: plan.fs,
			}),
			...(workbench ? { workbench } : {}),
		})
		ctx.effects.defer(() => logging.dispose(), {
			tag: 'RuntimeLogging',
			phase: 'shutdown',
		})
		await Promise.all([requireConfigService(ctx).ready, requireRuntimeStateStore(ctx).ready])
		await logging.initializePolicy(createContextPluginLogPolicyStore(ctx))
		await prepareRuntimeRootContext(ctx.root)
		void requireLoaderService(ctx)

		const hmr = await startLoaderHmr(
			ctx,
			plan,
			options.viteServer,
			options.workbenchArtifactCacheDir,
			options.workbenchAssets === 'built' ? 'distribution' : 'development',
		)
		const platform = describePluxelPlatform()
		ctx.logger.info('Runtime started', {
			profile: plan.snapshot.activeProfile,
			workbench: ctx.workbench !== undefined,
			persistenceRoot: plan.runtimeStorage.persistenceDir,
			runtime: platform.runtime.name,
			runtimeVersion: platform.runtime.version,
			deploymentProvider: platform.deployment.provider,
			ci: platform.deployment.ci,
			mode: platform.mode,
		})

		return {
			root: plan.root,
			logsDir: plan.runtimeStorage.logsDir,
			ctx,
			hmr,
			stop: createLoaderRuntimeStop(ctx, hmr, logging),
		}
	} catch (error) {
		try {
			await ctx?.effects.dispose()
		} finally {
			await logging.dispose()
		}
		throw error
	}
}

function resolveLoaderRuntimeLoggingInput(
	plan: PlannedLoaderHmrHost<LoaderHmrWorkspaceSnapshot>,
): RuntimeLoggingInput {
	if (plan.logging) return plan.logging
	const root = { profile: plan.snapshot.activeProfile, debugTopics: plan.debug }
	if (plan.logging === false) {
		return {
			root,
			sinks: {},
			routes: { runtime: [], plugins: [], debug: [], meta: [] },
		}
	}
	const withStore = isWorkbenchEnabled(plan.runtimeConfig.workbench)
	const sinks: RuntimeLoggingInput['sinks'] = {
		console: {
			kind: 'console',
			format: 'pretty',
			caller: false,
			timezone: 'local',
		},
		file: {
			kind: 'file',
			path: plan.runtimeStorage.logFile,
			format: 'text',
			caller: true,
			timezone: 'local',
		},
	}
	if (withStore) sinks.store = { kind: 'store', streamId: 'default', caller: true }
	const storeRoute = withStore ? [{ sink: 'store', minLevel: 'trace' as const }] : []
	return {
		root,
		sinks,
		routes: {
			runtime: [
				{ sink: 'console', minLevel: 'info' },
				{ sink: 'file', minLevel: 'trace' },
				...storeRoute,
			],
			plugins: [
				{ sink: 'console', minLevel: 'trace' },
				{ sink: 'file', minLevel: 'trace' },
				...storeRoute,
			],
			debug: [
				{ sink: 'console', minLevel: 'trace' },
				{ sink: 'file', minLevel: 'trace' },
				...storeRoute,
			],
			meta: [{ sink: 'console', minLevel: 'warning' }],
		},
	}
}

function createLoaderRuntimeStop(
	ctx: Context,
	hmr: LoaderHmrService,
	logging: RuntimeLogging,
): () => Promise<void> {
	let promise: Promise<void> | undefined
	return () =>
		(promise ??= (async () => {
			try {
				try {
					await hmr.close()
				} finally {
					await stopRuntimePluginGraph(ctx)
				}
			} finally {
				try {
					await ctx.effects.dispose()
				} finally {
					await logging.dispose()
				}
			}
		})())
}

async function stopRuntimePluginGraph(ctx: Context): Promise<void> {
	await requireLoaderService(ctx).shutdown()
}

function mergeRuntimeHostConfig(
	base: RuntimeHostConfig,
	override: RuntimeHostConfig,
): RuntimeHostConfig {
	return compactRuntimeHostConfig({
		...base,
		...override,
		configService: mergeRecord(base.configService, override.configService),
		runtimeState: mergeRecord(base.runtimeState, override.runtimeState),
		persistence: override.persistence ?? base.persistence,
		database: override.database !== undefined ? override.database : base.database,
		http: mergeRecord(base.http, override.http),
		workbench: override.workbench ?? base.workbench,
	})
}

function compactRuntimeHostConfig(config: RuntimeHostConfig): RuntimeHostConfig {
	return Object.fromEntries(
		Object.entries(config).filter(([, value]) => value !== undefined),
	) as RuntimeHostConfig
}

function mergeRecord<T>(base: T | undefined, override: T | undefined): T | undefined {
	if (base && override && isPlainRecord(base) && isPlainRecord(override)) {
		return { ...base, ...override } as T
	}
	return override ?? base
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

async function startLoaderHmr<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	ctx: Context,
	plan: PlannedLoaderHmrHost<TSnapshot>,
	viteServer: ViteDevServer | undefined,
	workbenchArtifactCacheDir: string | undefined,
	workbenchPackageMode: 'development' | 'distribution',
): Promise<LoaderHmrService> {
	const baseRoute = readRuntimeRouteCapabilities(ctx)
	if (baseRoute?.modules) {
		throw new Error('[loader-hmr-host] Context already has loader HMR runtime state')
	}

	const loaderHmr = resolveLoaderHmrConfig(plan)
	if (!baseRoute) {
		throw new Error(
			'[loader-hmr-host] Loader route capabilities must be registered before HMR starts',
		)
	}
	const hmr = new LoaderHmrService(ctx, loaderHmr, viteServer)
	const uninstallRoute = installRuntimeRouteCapabilities(ctx, {
		...baseRoute,
		dynamicPluginSources: createDynamicPluginSourceReader(plan.dynamicSources),
		modules: hmr,
	})
	ctx.effects.defer(uninstallRoute, { tag: 'LoaderHmrRouteCapabilities', phase: 'shutdown' })

	const artifactCompiler = attachPluginArtifactCompiler(ctx, {
		cacheDir: workbenchArtifactCacheDir ?? resolve(plan.root, '.pluxel/plugin-artifacts'),
		packageMode: workbenchPackageMode,
		viteServer: viteServer ?? hmr.vite,
	})
	if (ctx.workbench) {
		attachLoaderHmrWorkbenchProducerPublisher(hmr, (inputs) =>
			artifactCompiler.publishWorkbenchProducers(inputs),
		)
	}

	return hmr
}

function createDynamicPluginSourceReader(sources: readonly DynamicPluginSource[]) {
	const files = new Set(
		sources.flatMap((source) =>
			source.kind === 'file' ? [resolve(source.path).replaceAll('\\', '/')] : [],
		),
	)
	const directories = sources.flatMap((source) =>
		source.kind === 'directory'
			? [{ path: resolve(source.path).replaceAll('\\', '/'), include: new Set(source.include) }]
			: [],
	)
	return {
		hasFile(path: string): boolean {
			return files.has(resolve(path).replaceAll('\\', '/'))
		},
		hasDirectory(path: string, include: readonly string[]): boolean {
			const normalizedPath = resolve(path).replaceAll('\\', '/')
			const normalizedInclude = new Set(include.map((pattern) => pattern.replaceAll('\\', '/')))
			return directories.some(
				(directory) =>
					directory.path === normalizedPath &&
					directory.include.size === normalizedInclude.size &&
					[...normalizedInclude].every((pattern) => directory.include.has(pattern)),
			)
		},
	}
}

function withWorkbenchHttpConfig(
	config: RuntimeHostConfig['http'] | undefined,
	assets: 'source' | 'built',
): RuntimeHostConfig['http'] {
	const next = {
		...config,
		uiAssets: assets === 'built' ? ('static-built' as const) : ('dev-server' as const),
	}
	return next
}

function resolveLoaderHmrConfig<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	plan: PlannedLoaderHmrHost<TSnapshot>,
): LoaderHmrConfig {
	return applyLoaderHmrEnvOverrides({
		hostRoot: plan.root,
		roots: plan.snapshot.watchRoots,
		printUrls: plan.printUrls ?? true,
		include:
			plan.snapshot.includeGlobs.length > 0 ? uniqSorted(plan.snapshot.includeGlobs) : undefined,
		entries: plan.snapshot.enabledEntries,
		exclude:
			plan.snapshot.excludeGlobs.length > 0 ? uniqSorted(plan.snapshot.excludeGlobs) : undefined,
		clientEntries: resolveDefaultClientEntries(plan.root),
		fixedPlugins: plan.plugins,
		fixedModuleId: plan.fixedModuleId,
	})
}

function uniqSorted(list: readonly string[]): string[] {
	return [...new Set(list)].sort((a, b) => a.localeCompare(b))
}

function resolveDefaultClientEntries(cwd: string): string[] {
	const workbenchClientEntry = resolve(cwd, 'packages/workbench-app/src/client.tsx')
	return existsSync(workbenchClientEntry) ? [workbenchClientEntry] : []
}
