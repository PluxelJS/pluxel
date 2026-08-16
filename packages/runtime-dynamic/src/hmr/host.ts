import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'pathe'
import type { ViteDevServer } from 'vite'

import '../register-services'
import type { Context as CoreContext, PluginConstructor } from '@pluxel/core'
import {
	createContextPluginLogPolicyStore,
	createNodeWorkspaceFsBackend,
	createRuntimeLogging,
	isWorkbenchEnabled,
	resolvePackagedWorkbenchManifest,
	resolvePackagedNodeModule,
	resolveRuntimeStoragePaths,
	workbenchAdminAccess,
	withPluginConfigEnvironment,
	withWorkbenchPluginContext,
	type RuntimeLogging,
	type RuntimeLoggingInput,
	type RuntimeStoragePaths,
} from '@pluxel/runtime/internal'
import { Context, createWorkspacePersistenceBackend } from '@pluxel/runtime'
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
import { LoaderHmrService, type LoaderHmrConfig } from './engine/LoaderHmrService'
import { applyLoaderHmrEnvOverrides } from './hmr-env'
import { assertLoaderHmrWorkspace, type LoaderHmrWorkspaceSnapshot } from './snapshot'
import { resolveDynamicPluginSources, type DynamicPluginSource } from '../sources'

const nodeHostFs = nodeLoaderHmrWorkspaceFs

export type LoaderHmrHostStorageOptions = DynamicRuntimeStorageOptions

export type LoaderHmrHostOptions<
	TSnapshot extends LoaderHmrWorkspaceSnapshot = LoaderHmrWorkspaceSnapshot,
> = {
	root?: string
	chdir?: boolean
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
	registry?: Record<string, unknown>
	context?: CoreContext.Config
}

export type PlannedLoaderHmrHost<
	TSnapshot extends LoaderHmrWorkspaceSnapshot = LoaderHmrWorkspaceSnapshot,
> = {
	root: string
	chdir: boolean
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
	registry?: Record<string, unknown>
	context?: CoreContext.Config
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
	configService?: CoreContext.Config['configService']
	runtimeState?: CoreContext.Config['runtimeState']
	persistence?: CoreContext.Config['persistence']
	database?: CoreContext.Config['database']
	http?: CoreContext.Config['http']
	workbench?: CoreContext.Config['workbench']
	logging?: false | RuntimeLoggingInput
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
		persistenceDir: storage?.persistenceDir ?? '.pluxel/persistence',
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
		chdir: opts.chdir !== false,
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
		registry: opts.registry,
		context: opts.context,
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
		runtimeState,
		persistence,
		database,
		http,
		workbench,
		logging,
		sources,
		context,
		...hostOpts
	} = opts

	const rootDir = resolve(process.cwd(), hostOpts.root ?? '.')
	const configPathAbs = (() => {
		if (configPath) return isAbsolute(configPath) ? configPath : resolve(rootDir, configPath)
		return resolveDefaultLoaderHmrConfigPath(rootDir)
	})()
	const env: Record<string, string | undefined> = {
		...process.env,
		...(profile ? { PLUXEL_HMR_PROFILE: profile } : {}),
		...envOverrides,
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
			...hostOpts,
			root: rootDir,
			snapshot,
			warnings: diagnosed.warnings,
			context: mergeContextConfig(context, {
				configService: withPluginConfigEnvironment(configService, env),
				runtimeState,
				persistence,
				database,
				http,
				workbench,
			}),
			logging,
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
	if (plan.chdir) process.chdir(plan.root)
	await plan.fs.promises.mkdir(plan.runtimeStorage.logsDir, { recursive: true })
	const logging = createRuntimeLogging(resolveLoaderRuntimeLoggingInput(plan))
	await logging.install()
	let ctx: Context | undefined

	try {
		const runtimeFsBackend = createNodeWorkspaceFsBackend(plan.fs)
		const defaultContext: CoreContext.Config = {
			debug: plan.debug,
			registry: plan.registry,
			profile: plan.snapshot.activeProfile,
			logger: logging.contextBinding,
			persistence: {
				mode: 'custom',
				backend: createWorkspacePersistenceBackend(runtimeFsBackend, {
					root: plan.runtimeStorage.persistenceDir,
				}),
			},
			workbenchArtifactResolver: resolvePackagedWorkbenchManifest,
			nodeModuleArtifactResolver: resolvePackagedNodeModule,
		}
		const contextConfig = withWorkbenchPluginContext(
			mergeContextConfig(defaultContext, plan.context),
		)
		contextConfig.logger = logging.contextBinding
		contextConfig.adminAccess = workbenchAdminAccess(contextConfig.workbench)
		if (isWorkbenchEnabled(contextConfig.workbench)) {
			contextConfig.http = withWorkbenchHttpConfig(
				contextConfig.http,
				options.workbenchAssets ?? 'source',
			)
		}
		ctx = new Context(contextConfig)
		ctx.effects.defer(() => logging.dispose(), {
			tag: 'RuntimeLogging',
			phase: 'shutdown',
		})
		if (isWorkbenchEnabled(contextConfig.workbench)) {
			const { installWorkbench } = await import('@pluxel/runtime/internal')
			installWorkbench(ctx, { product: options.product ?? null })
		}
		await Promise.all([ctx.root.configService.ready, ctx.root.runtimeState.ready])
		await logging.initializePolicy(createContextPluginLogPolicyStore(ctx))
		await ctx.prepareServices()
		void ctx.loader

		const hmr = await startLoaderHmr(
			ctx,
			plan,
			options.viteServer,
			options.workbenchArtifactCacheDir,
		)

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
	const withStore = isWorkbenchEnabled(plan.context?.workbench)
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
	ctx.registry.resetDraft()
	const update = ctx.registry.beginUpdate({ reason: 'shutdown' })
	try {
		const plugins = ctx.registry.graph
			.declarationsBySlot()
			.map((declaration) => declaration?.meta?.class)
			.filter((plugin): plugin is PluginConstructor => typeof plugin === 'function')
		for (const plugin of plugins) {
			if (ctx.registry.isRegistered(plugin)) update.unregister(plugin)
		}
		const result = await update.commit({ rollbackOnFailure: false })
		if (!result.ok) {
			update.rollback()
			throw new Error('[loader-hmr-host] plugin shutdown commit failed', {
				cause: result.err,
			})
		}
	} catch (error) {
		update.rollback()
		throw error
	} finally {
		ctx.registry.resetDraft()
	}
}

function mergeContextConfig(
	base: CoreContext.Config | undefined,
	override: CoreContext.Config | undefined,
): CoreContext.Config {
	if (!base) return compactContextConfig(override)
	if (!override) return compactContextConfig(base)
	return compactContextConfig({
		...base,
		...override,
		configService: mergeRecord(base.configService, override.configService),
		runtimeState: mergeRecord(base.runtimeState, override.runtimeState),
		persistence: mergeRecord(base.persistence, override.persistence),
		database: override.database !== undefined ? override.database : base.database,
		http: mergeRecord(base.http, override.http),
		workbench: override.workbench ?? base.workbench,
	})
}

function compactContextConfig(config: CoreContext.Config | undefined): CoreContext.Config {
	if (!config) return {}
	return Object.fromEntries(
		Object.entries(config).filter(([, value]) => value !== undefined),
	) as CoreContext.Config
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
): Promise<LoaderHmrService> {
	if (ctx.config.loaderHmr || ctx.runtimeRoute?.modules) {
		throw new Error('[loader-hmr-host] Context already has loader HMR runtime state')
	}

	const loaderHmr = resolveLoaderHmrConfig(plan)
	ctx.config.loaderHmr = loaderHmr
	const baseRoute = ctx.runtimeRoute
	if (!baseRoute) {
		throw new Error(
			'[loader-hmr-host] Loader route capabilities must be registered before HMR starts',
		)
	}
	ctx.runtimeRoute = {
		...baseRoute,
		dynamicPluginSources: createDynamicPluginSourceReader(plan.dynamicSources),
	}

	const hmr = new LoaderHmrService(ctx, loaderHmr, viteServer)

	const routeWithSources = ctx.runtimeRoute
	ctx.runtimeRoute = {
		...routeWithSources,
		modules: hmr,
	}
	ctx.effects.defer(() => {
		ctx.runtimeRoute = baseRoute
	})

	attachPluginArtifactCompiler(ctx, {
		cacheDir: workbenchArtifactCacheDir,
		viteServer: viteServer ?? hmr.vite,
	})

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
	config: CoreContext.Config['http'] | undefined,
	assets: 'source' | 'built',
): CoreContext.Config['http'] {
	const next = {
		...config,
		controlPlane: { web: true, rpc: true, sse: true },
		uiAssets: assets === 'built' ? 'static-built' : 'dev-server',
	}
	return next
}

function resolveLoaderHmrConfig<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	plan: PlannedLoaderHmrHost<TSnapshot>,
): LoaderHmrConfig {
	return applyLoaderHmrEnvOverrides({
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
