import { isAbsolute, resolve } from 'pathe'
import type { Plugin as VitePlugin } from 'vite'

import { setPluxelRuntime } from '@pluxel/core'
import { ensurePluxelLogging, type EnsurePluxelLoggingOptions } from '@pluxel/runtime/logger'
import {
	resolveRuntimeStoragePaths,
	type RuntimeStoragePaths,
} from '@pluxel/runtime/internal'
import { Context } from '@pluxel/runtime'
import {
	createNodeFsServiceBackend,
	type BuiltinPluginSpec,
} from '@pluxel/runtime/services'

import { attachHmrRuntime } from './dev/attach-runtime'
import type { HMRConfig } from './dev/hmr/HMRService'
import type { HMRDependencyConfig } from './dev/hmr/config'
import { applyHmrEnvOverrides } from './dev/runtime'
import {
	diagnoseWorkspace,
	nodeHmrWorkspaceFs,
	resolveDefaultHmrConfigPath,
	type HmrWorkspaceFs,
	type WorkspaceSnapshot,
} from './diagnose'
import { materializeProfiledFile } from './host/storage'
import { assertHmrWorkspaceSnapshot, type HmrWorkspaceSnapshot } from './snapshot'

const nodeHostFs = nodeHmrWorkspaceFs

export type HmrHostStorageOptions = {
	configFile?: string
	seedConfig?: string | false
	pluginDataDir?: string
}

export type HmrHostConfigMaterialization = {
	basePath: string
	profile: string
	seedFile: string | false
}

export type PlanHmrHostOptions<TSnapshot extends HmrWorkspaceSnapshot = HmrWorkspaceSnapshot> = {
	root?: string
	chdir?: boolean
	fs?: HmrWorkspaceFs
	debug?: readonly string[]
	snapshot: TSnapshot
	warnings?: readonly string[]
	snapshotPatch?: (snapshot: TSnapshot) => TSnapshot
	builtins?: readonly BuiltinPluginSpec[]
	builtinsFromDist?: HMRConfig['builtinsFromDist']
	warmup?: boolean
	printUrls?: boolean
	vitePlugins?: VitePlugin[]
	deps?: HMRDependencyConfig
	cjsExternal?: readonly string[]
	logging?: boolean | EnsurePluxelLoggingOptions
	logsDir?: string
	logFile?: string
	storage?: HmrHostStorageOptions
	registry?: Record<string, unknown>
	context?: Record<string, unknown>
}

export type PlannedHmrHost<TSnapshot extends HmrWorkspaceSnapshot = HmrWorkspaceSnapshot> = {
	root: string
	chdir: boolean
	fs: HmrWorkspaceFs
	debug: readonly string[]
	snapshot: TSnapshot
	warnings: readonly string[]
	builtins?: readonly BuiltinPluginSpec[]
	builtinsFromDist?: HMRConfig['builtinsFromDist']
	warmup?: boolean
	printUrls?: boolean
	vitePlugins?: VitePlugin[]
	deps?: HMRDependencyConfig
	cjsExternal?: readonly string[]
	logging?: boolean | EnsurePluxelLoggingOptions
	runtimeStorage: RuntimeStoragePaths
	configMaterialization?: HmrHostConfigMaterialization
	registry?: Record<string, unknown>
	context?: Record<string, unknown>
}

export type BootedHmrHost = {
	root: string
	logsDir: string
	ctx: import('@pluxel/core').Context
	hmr: import('./dev/hmr/HMRService').HMRService
}

export type PlanHmrHostFromConfigOptions = Omit<
	PlanHmrHostOptions<WorkspaceSnapshot>,
	'snapshot' | 'warnings'
> & {
	configPath?: string
	profile?: string
	env?: Record<string, string | undefined>
	omitPackages?: string[]
}

function planRuntimeStorage(
	root: string,
	snapshot: HmrWorkspaceSnapshot,
	storage: HmrHostStorageOptions | undefined,
	logs: Pick<PlanHmrHostOptions, 'logsDir' | 'logFile'>,
): {
	runtimeStorage: RuntimeStoragePaths
	configMaterialization?: HmrHostConfigMaterialization
} {
	const runtimeStorage = resolveRuntimeStoragePaths(root, {
		...(storage
			? {
					configFile: storage.configFile ?? '.pluxel/hmr/config.json',
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

export function planHmrHost<TSnapshot extends HmrWorkspaceSnapshot>(
	opts: PlanHmrHostOptions<TSnapshot>,
): PlannedHmrHost<TSnapshot> {
	const root = resolve(opts.root ?? process.cwd())
	const fs = opts.fs ?? nodeHostFs

	let snapshot = opts.snapshot
	if (!snapshot) {
		throw new Error(
			'[hmr-host] snapshot is required (compute it in your caller, e.g. via @pluxel/hmr/diagnose)',
		)
	}
	if (opts.snapshotPatch) snapshot = opts.snapshotPatch(snapshot)
	assertHmrWorkspaceSnapshot(snapshot)

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
		vitePlugins: opts.vitePlugins,
		deps: opts.deps,
		cjsExternal: opts.cjsExternal,
		logging: opts.logging,
		runtimeStorage,
		configMaterialization,
		registry: opts.registry,
		context: opts.context,
	}
}

export async function planHmrHostFromConfig(
	opts: PlanHmrHostFromConfigOptions,
): Promise<PlannedHmrHost<WorkspaceSnapshot>> {
	const { configPath, profile, env: envOverrides, omitPackages, ...hostOpts } = opts

	const rootDir = resolve(process.cwd(), hostOpts.root ?? '.')
	const configPathAbs = (() => {
		if (configPath) return isAbsolute(configPath) ? configPath : resolve(rootDir, configPath)
		return resolveDefaultHmrConfigPath(rootDir)
	})()
	const env: Record<string, string | undefined> = {
		...process.env,
		...(profile ? { PLUXEL_HMR_PROFILE: profile } : {}),
		...(envOverrides ?? {}),
	}

	const diagnosed = await diagnoseWorkspace({
		rootDir,
		configPath: configPathAbs,
		env,
		omitPackages,
		fs: hostOpts.fs,
	})
	if (diagnosed.ok === false) throw new Error(diagnosed.errors.join('\n'))

	return planHmrHost({
		...hostOpts,
		root: rootDir,
		snapshot: diagnosed.snapshot,
		warnings: diagnosed.warnings,
	})
}

export { applyHmrEnvOverrides }

export async function bootPlannedHmrHost<TSnapshot extends HmrWorkspaceSnapshot>(
	plan: PlannedHmrHost<TSnapshot>,
): Promise<BootedHmrHost> {
	// `@pluxel/runtime` sets process runtime to "core"; override it back to "hmr" for dev hosts.
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

	const ctx = new Context({
		debug: plan.debug,
		registry: plan.registry,
		profile: plan.snapshot.activeProfile,
		logger: { preset: 'hmr' },
		configService: {
			mode: 'file',
			path: plan.runtimeStorage.configFile,
		},
		fs: {
			backend: createNodeFsServiceBackend(plan.fs),
		},
		pluginData: { dir: plan.runtimeStorage.pluginDataDir },
		packageService: {
			state: { enabled: true, file: plan.runtimeStorage.packageStateFile },
		},
		...(plan.context ?? {}),
	})
	await ctx.root.configService.ready

	const dev = await attachHmrRuntime(ctx, {
		cwd: plan.root,
		snapshot: plan.snapshot,
		printUrls: plan.printUrls,
		warmup: plan.warmup,
		vitePlugins: plan.vitePlugins,
		deps: plan.deps,
		cjsExternal: plan.cjsExternal,
		builtinsFromDist: plan.builtinsFromDist,
	})

	if (plan.builtins?.length) {
		await ctx.loader.preloadPlugins([...plan.builtins], { strict: true, commit: true })
	}

	return { root: plan.root, logsDir: plan.runtimeStorage.logsDir, ctx, hmr: dev.hmr }
}
