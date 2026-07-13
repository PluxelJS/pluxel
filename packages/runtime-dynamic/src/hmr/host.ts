import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'pathe'
import type { InlineConfig, ViteDevServer } from 'vite'

import '@pluxel/runtime-dynamic/register'
import { setPluxelRuntime, type Context as CoreContext } from '@pluxel/core'
import { ensurePluxelLogging, type EnsurePluxelLoggingOptions } from '@pluxel/runtime/logger'
import {
	createNodeWorkspaceFsBackend,
	isManagementEnabled,
	managementAdminAccess,
	resolveRuntimeStoragePaths,
	withManagementPluginContext,
	type RuntimeStoragePaths,
} from '@pluxel/runtime/internal'
import { requireManagement } from '@pluxel/runtime/services/management'
import { Context, createWorkspacePersistenceBackend } from '@pluxel/runtime'
import { mergeManagementCompilerViteConfig } from '@pluxel/runtime-dev'
import type { BuiltinPluginSpec } from '@pluxel/runtime-dynamic/services'

import { BundlerService } from './compile/bundler/BundlerService'
import {
	diagnoseWorkspace,
	nodeLoaderHmrWorkspaceFs,
	resolveDefaultLoaderHmrConfigPath,
	type LoaderHmrWorkspaceFs,
	type WorkspaceSnapshot,
} from './diagnose'
import type { LoaderHmrDependencyConfig } from './engine/config'
import { LoaderHmrService, type LoaderHmrConfig } from './engine/LoaderHmrService'
import { ManagementCompilerService } from './management/ManagementCompilerService'
import { applyLoaderHmrEnvOverrides } from './hmr-env'
import { assertLoaderHmrWorkspace, type LoaderHmrWorkspaceSnapshot } from './snapshot'

const nodeHostFs = nodeLoaderHmrWorkspaceFs

export type LoaderHmrHostStorageOptions = {
	persistenceDir?: string
}

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
	builtins?: readonly BuiltinPluginSpec[]
	builtinsFromDist?: LoaderHmrConfig['builtinsFromDist']
	warmup?: boolean
	printUrls?: boolean
	vite?: InlineConfig
	deps?: LoaderHmrDependencyConfig
	cjsExternal?: readonly string[]
	logging?: boolean | EnsurePluxelLoggingOptions
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
	builtins?: readonly BuiltinPluginSpec[]
	builtinsFromDist?: LoaderHmrConfig['builtinsFromDist']
	warmup?: boolean
	printUrls?: boolean
	vite?: InlineConfig
	deps?: LoaderHmrDependencyConfig
	cjsExternal?: readonly string[]
	logging?: boolean | EnsurePluxelLoggingOptions
	runtimeStorage: RuntimeStoragePaths
	registry?: Record<string, unknown>
	context?: CoreContext.Config
}

export type BootedLoaderHmrHost = {
	root: string
	logsDir: string
	ctx: import('@pluxel/core').Context
	hmr: LoaderHmrService
}

export type BootLoaderHmrHostOptions = {
	viteServer?: ViteDevServer
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
	pluginData?: CoreContext.Config['pluginData']
	http?: CoreContext.Config['http']
	management?: CoreContext.Config['management']
	logger?: CoreContext.Config['logger']
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

	let builtinsFromDist = opts.builtinsFromDist
	if (builtinsFromDist === undefined && opts.builtins === undefined) {
		builtinsFromDist = snapshot.builtinsFromDist?.length ? snapshot.builtinsFromDist : undefined
	}

	const { runtimeStorage } = planRuntimeStorage(root, opts.storage, {
		logsDir: opts.logsDir,
		logFile: opts.logFile,
	})

	return {
		root,
		chdir: opts.chdir !== false,
		fs,
		debug: opts.debug ?? ['pluxel:hmr:*'],
		snapshot,
		warnings: opts.warnings ?? [],
		builtins: opts.builtins,
		builtinsFromDist,
		warmup: opts.warmup,
		printUrls: opts.printUrls,
		vite: opts.vite,
		deps: opts.deps,
		cjsExternal: opts.cjsExternal,
		logging: opts.logging,
		runtimeStorage,
		registry: opts.registry,
		context: opts.context,
	}
}

export async function planLoaderHmrHostFromConfig(
	opts: LoaderHmrHostConfigInput,
): Promise<PlannedLoaderHmrHost<WorkspaceSnapshot>> {
	const {
		configPath,
		profile,
		env: envOverrides,
		omitPackages,
		configService,
		runtimeState,
		persistence,
		pluginData,
		http,
		management,
		logger,
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

	return planLoaderHmrHost({
		...hostOpts,
		root: rootDir,
		snapshot: diagnosed.snapshot,
		warnings: diagnosed.warnings,
		context: mergeContextConfig(context, {
			configService,
			runtimeState,
			persistence,
			pluginData,
			http,
			management,
			logger,
		}),
	})
}

export async function bootPlannedLoaderHmrHost<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	plan: PlannedLoaderHmrHost<TSnapshot>,
	options: BootLoaderHmrHostOptions = {},
): Promise<BootedLoaderHmrHost> {
	// `@pluxel/runtime` sets process runtime to "core"; use the hmr runtime preset for loader HMR hosts.
	// This affects logger preset defaults (category/name injection) and other runtime flags.
	setPluxelRuntime('hmr')

	if (plan.chdir) process.chdir(plan.root)

	const logging = plan.logging ?? true
	if (logging) {
		await plan.fs.promises.mkdir(plan.runtimeStorage.logsDir, { recursive: true })
		const base = typeof logging === 'object' ? { ...logging } : {}
		await ensurePluxelLogging({
			preset: base.preset ?? 'hmr',
			console: base.console,
			file: base.file ?? plan.runtimeStorage.logFile,
			ui: base.ui ?? true,
			debug: base.debug ?? plan.debug,
		})
	}

	const runtimeFsBackend = createNodeWorkspaceFsBackend(plan.fs)
	const defaultContext: CoreContext.Config = {
		debug: plan.debug,
		registry: plan.registry,
		profile: plan.snapshot.activeProfile,
		logger: { preset: 'hmr' },
		persistence: {
			mode: 'custom',
			backend: createWorkspacePersistenceBackend(runtimeFsBackend, {
				root: plan.runtimeStorage.persistenceDir,
			}),
		},
		packageService: {
			state: { enabled: true, file: plan.runtimeStorage.packageStateFile },
		},
	}
	const contextConfig = withManagementPluginContext(
		mergeContextConfig(defaultContext, plan.context),
	)
	contextConfig.adminAccess = managementAdminAccess(contextConfig.management)
	if (isManagementEnabled(contextConfig.management)) {
		contextConfig.http = withDevManagementHttpConfig(contextConfig.http)
	}
	const ctx = new Context(contextConfig)
	if (isManagementEnabled(contextConfig.management)) {
		const { installManagement } = await import('@pluxel/runtime/services/management')
		installManagement(ctx)
	}
	await Promise.all([ctx.root.configService.ready, ctx.root.runtimeState.ready])
	// Materialize the loader route before HMR contributes dev/module capabilities to it.
	void ctx.loader

	const hmr = await startLoaderHmr(ctx, plan, options.viteServer)

	if (plan.builtins?.length) {
		await ctx.loader.preloadPlugins([...plan.builtins], { strict: true, commit: true })
	}

	return { root: plan.root, logsDir: plan.runtimeStorage.logsDir, ctx, hmr }
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
		pluginData: mergeRecord(base.pluginData, override.pluginData),
		http: mergeRecord(base.http, override.http),
		logger: mergeRecord(base.logger, override.logger),
		management: override.management ?? base.management,
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
): Promise<LoaderHmrService> {
	if (ctx.config.loaderHmr || ctx.runtimeRoute?.modules || ctx.runtimeDev) {
		throw new Error('[loader-hmr-host] Context already has loader HMR runtime state')
	}

	const loaderHmr = resolveLoaderHmrConfig(plan)
	ctx.config.loaderHmr = loaderHmr

	const hmr = new LoaderHmrService(ctx, loaderHmr, viteServer)

	const bundler = new BundlerService(ctx)
	let managementCompiler: ManagementCompilerService | undefined
	if (ctx.management.enabled) {
		const managementCompilerConfig = mergeManagementCompilerViteConfig(
			ctx.config.managementCompiler,
			plan.vite,
		)
		ctx.config.managementCompiler = managementCompilerConfig
		const extensionStore = requireManagement(ctx).registry.getArtifacts()
		managementCompiler = new ManagementCompilerService(
			ctx,
			{ store: extensionStore, viteServer: viteServer ?? hmr.vite, enabled: true },
			managementCompilerConfig,
		)
	}

	const baseRoute = ctx.runtimeRoute
	const baseDev = ctx.runtimeDev
	if (!baseRoute) {
		throw new Error(
			'[loader-hmr-host] Loader route capabilities must be registered before HMR starts',
		)
	}
	ctx.runtimeRoute = {
		...baseRoute,
		modules: hmr,
	}
	ctx.runtimeDev = {
		...baseDev,
		batches: {
			lastBatch: hmr.api.lastBatch,
			waitForBatch: hmr.api.waitForBatch,
			waitForStable: hmr.api.waitForStable,
			waitForIdle: hmr.api.waitForIdle,
			executeFiles: (files, keepOrder) => hmr.executeFiles(files, keepOrder !== false),
		},
		worker: {
			watch: (ownerCtx, tsEntry, bundlerOptions) =>
				bundler.watchTinypoolWorker(ownerCtx, tsEntry, {
					...bundlerOptions,
					vite: hmr.vite,
				}),
		},
		...(managementCompiler
			? {
					managementUiSource: {
						bind: (ownerCtx, declaration) =>
							managementCompiler!.bindDeclaration(ownerCtx, declaration),
					},
				}
			: {}),
	}

	ctx.effects.defer(() => {
		ctx.runtimeRoute = baseRoute
		ctx.runtimeDev = baseDev
		managementCompiler?.dispose()
		return bundler.dispose()
	})

	return hmr
}

function withDevManagementHttpConfig(
	config: CoreContext.Config['http'] | undefined,
): CoreContext.Config['http'] {
	const next = {
		...config,
		controlPlane: { web: true, rpc: true, sse: true },
		uiAssets: 'dev-server',
	}
	return next
}

function resolveLoaderHmrConfig<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	plan: PlannedLoaderHmrHost<TSnapshot>,
): LoaderHmrConfig {
	const deps: LoaderHmrDependencyConfig | undefined = plan.cjsExternal?.length
		? { ...plan.deps, cjsExternal: plan.cjsExternal }
		: plan.deps
	const builtinsFromDist = resolveBuiltinsFromDistEntries(
		plan.root,
		plan.builtinsFromDist ?? plan.snapshot.builtinsFromDist,
	)

	return applyLoaderHmrEnvOverrides({
		roots: plan.snapshot.watchRoots,
		printUrls: plan.printUrls ?? true,
		warmup: plan.warmup ?? true,
		include:
			plan.snapshot.includeGlobs.length > 0 ? uniqSorted(plan.snapshot.includeGlobs) : undefined,
		entries: plan.snapshot.enabledEntries,
		exclude:
			plan.snapshot.excludeGlobs.length > 0 ? uniqSorted(plan.snapshot.excludeGlobs) : undefined,
		clientEntries: resolveDefaultClientEntries(plan.root),
		builtinsFromDist,
		vite: plan.vite,
		deps,
	})
}

function uniqSorted(list: readonly string[]): string[] {
	return [...new Set(list)].sort((a, b) => a.localeCompare(b))
}

function resolveDefaultClientEntries(cwd: string): string[] {
	const runtimeClientEntry = resolve(cwd, 'packages/runtime/src/client.tsx')
	return existsSync(runtimeClientEntry) ? [runtimeClientEntry] : []
}

function resolveBuiltinsFromDistEntries(
	cwd: string,
	list: LoaderHmrConfig['builtinsFromDist'],
): LoaderHmrConfig['builtinsFromDist'] {
	if (!list?.length) return list
	return list
		.map((entry) => ({
			...entry,
			packageName: String(entry.packageName ?? '').trim(),
			entry: (() => {
				const raw = String(entry.entry ?? '').trim()
				if (!raw) return raw
				return isAbsolute(raw) ? raw : resolve(cwd, raw)
			})(),
		}))
		.filter((entry) => entry.packageName && entry.entry)
}
