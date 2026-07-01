import { existsSync } from 'node:fs'
import { isAbsolute, resolve } from 'pathe'
import type { InlineConfig, ViteDevServer } from 'vite'

import '@pluxel/runtime-dynamic/register'
import { setPluxelRuntime } from '@pluxel/core'
import { ensurePluxelLogging, type EnsurePluxelLoggingOptions } from '@pluxel/runtime/logger'
import {
	createNodeWorkspaceFsBackend,
	resolveRuntimeStoragePaths,
	type RuntimeStoragePaths,
} from '@pluxel/runtime/internal'
import { Context, createWorkspacePersistenceBackend } from '@pluxel/runtime'
import { bootstrapHostVault } from '@pluxel/runtime/services/vault'
import { mergeExtensionCompilerViteConfig } from '@pluxel/runtime-dev'
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
import { ExtensionCompilerService } from './extensions/ExtensionCompilerService'
import { applyLoaderHmrEnvOverrides } from './hmr-env'
import { materializeProfiledFile } from './host/storage'
import { assertLoaderHmrWorkspace, type LoaderHmrWorkspaceSnapshot } from './snapshot'

const nodeHostFs = nodeLoaderHmrWorkspaceFs

export type LoaderHmrHostStorageOptions = {
	configFile?: string
	runtimeStateFile?: string
	persistenceDir?: string
	seedConfig?: string | false
	pluginDataDir?: string
}

export type LoaderHmrHostConfigMaterialization = {
	basePath: string
	profile: string
	seedFile: string | false
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
	context?: Record<string, unknown>
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
	configMaterialization?: LoaderHmrHostConfigMaterialization
	registry?: Record<string, unknown>
	context?: Record<string, unknown>
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
}

function planRuntimeStorage(
	root: string,
	snapshot: LoaderHmrWorkspaceSnapshot,
	storage: LoaderHmrHostStorageOptions | undefined,
	logs: Pick<LoaderHmrHostOptions, 'logsDir' | 'logFile'>,
): {
	runtimeStorage: RuntimeStoragePaths
	configMaterialization?: LoaderHmrHostConfigMaterialization
} {
	const runtimeStorage = resolveRuntimeStoragePaths(root, {
		...(storage
			? {
					configFile: storage.configFile ?? '.pluxel/loader-hmr/config.json',
					runtimeStateFile: storage.runtimeStateFile ?? '.pluxel/loader-hmr/state.json',
					persistenceDir: storage.persistenceDir ?? '.pluxel/persistence',
					pluginDataDir: storage.pluginDataDir ?? '.pluxel/plugin-data',
				}
			: {}),
		...(logs.logsDir ? { logsDir: logs.logsDir } : {}),
		...(logs.logFile ? { logFile: logs.logFile } : {}),
	})

	return {
		runtimeStorage,
		...(storage
			? {
					configMaterialization: {
						basePath: runtimeStorage.configFile,
						profile: snapshot.activeProfile,
						seedFile:
							storage.seedConfig === false
								? false
								: resolve(root, storage.seedConfig ?? 'default.json'),
					},
				}
			: {}),
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

	const { runtimeStorage, configMaterialization } = planRuntimeStorage(
		root,
		snapshot,
		opts.storage,
		{ logsDir: opts.logsDir, logFile: opts.logFile },
	)

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
		configMaterialization,
		registry: opts.registry,
		context: opts.context,
	}
}

export async function planLoaderHmrHostFromConfig(
	opts: LoaderHmrHostConfigInput,
): Promise<PlannedLoaderHmrHost<WorkspaceSnapshot>> {
	const { configPath, profile, env: envOverrides, omitPackages, ...hostOpts } = opts

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
	if (plan.configMaterialization) {
		await materializeProfiledFile(
			plan.configMaterialization.basePath,
			{
				profile: plan.configMaterialization.profile,
				seedFile: plan.configMaterialization.seedFile,
			},
			plan.fs,
		)
	}

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
	const ctx = new Context({
		debug: plan.debug,
		registry: plan.registry,
		profile: plan.snapshot.activeProfile,
		logger: { preset: 'hmr' },
		configService: {
			mode: 'file',
			path: plan.runtimeStorage.configFile,
		},
		runtimeState: {
			mode: 'file',
			path: plan.runtimeStorage.runtimeStateFile,
		},
		persistence: {
			backend: createWorkspacePersistenceBackend(runtimeFsBackend, {
				root: plan.runtimeStorage.persistenceDir,
			}),
		},
		pluginData: { dir: plan.runtimeStorage.pluginDataDir },
		packageService: {
			state: { enabled: true, file: plan.runtimeStorage.packageStateFile },
		},
		...plan.context,
	})
	await Promise.all([ctx.root.configService.ready, ctx.root.runtimeState.ready])
	await bootstrapHostVault(ctx)
	// Materialize the loader route before HMR contributes dev/module capabilities to it.
	void ctx.loader

	const hmr = await startLoaderHmr(ctx, plan, options.viteServer)

	if (plan.builtins?.length) {
		await ctx.loader.preloadPlugins([...plan.builtins], { strict: true, commit: true })
	}

	return { root: plan.root, logsDir: plan.runtimeStorage.logsDir, ctx, hmr }
}

async function startLoaderHmr<TSnapshot extends LoaderHmrWorkspaceSnapshot>(
	ctx: Context,
	plan: PlannedLoaderHmrHost<TSnapshot>,
	viteServer: ViteDevServer | undefined,
): Promise<LoaderHmrService> {
	if (ctx.config.loaderHmr || ctx.runtimeRoute?.modules || ctx.runtimeRoute?.dev) {
		throw new Error('[loader-hmr-host] Context already has loader HMR runtime state')
	}

	const loaderHmr = resolveLoaderHmrConfig(plan)
	ctx.config.loaderHmr = loaderHmr

	const hmr = new LoaderHmrService(ctx, loaderHmr, viteServer)

	const bundler = new BundlerService(ctx)
	const extensionCompilerConfig = mergeExtensionCompilerViteConfig(
		ctx.config.extensionCompiler,
		plan.vite,
	)
	ctx.config.extensionCompiler = extensionCompilerConfig
	ctx.config.http = { ...ctx.config.http, uiAssets: 'hmr-server' }
	ctx.config.extensionService = {
		...ctx.config.extensionService,
		enabled: true,
	}
	const extensionStore = ctx.ext.ui
	extensionStore.reconfigure(ctx.config.extensionService)
	const extensionCompiler = new ExtensionCompilerService(
		ctx,
		{ store: extensionStore, viteServer: viteServer ?? hmr.vite, enabled: true },
		extensionCompilerConfig,
	)

	const baseRoute = ctx.runtimeRoute
	if (!baseRoute) {
		throw new Error('[loader-hmr-host] Loader route capabilities must be registered before HMR starts')
	}
	ctx.runtimeRoute = {
		...baseRoute,
		modules: hmr,
		dev: {
			...baseRoute.dev,
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
			uiSource: {
				bind: (ownerCtx, declaration) =>
					extensionCompiler.bindDeclaration(ownerCtx, declaration),
			},
		},
	}

	ctx.effects.defer(() => {
		ctx.runtimeRoute = baseRoute
		extensionCompiler.dispose()
		return bundler.dispose()
	})

	return hmr
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
