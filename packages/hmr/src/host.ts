import { isAbsolute, resolve } from 'pathe'
import type { Plugin as VitePlugin } from 'vite'
import { mkdir } from 'node:fs/promises'

import { setPluxelRuntime } from '@pluxel/core'
import { ensurePluxelLogging, type EnsurePluxelLoggingOptions } from '@pluxel/runtime/logger'
import {
	resolveRuntimeStoragePaths,
	type RuntimeStorageLayout,
} from '@pluxel/runtime/internal'
import { Context } from '@pluxel/runtime'
import type { BuiltinPluginSpec } from '@pluxel/runtime/services'

import { attachHmrRuntime } from './dev/attach-runtime'
import type { HMRConfig } from './dev/hmr/HMRService'
import type { HMRDependencyConfig } from './dev/hmr/config'
import { applyHmrEnvOverrides } from './dev/runtime'
import { diagnoseWorkspace, resolveDefaultHmrConfigPath } from './diagnose'
import { materializeProfiledFile } from './host/storage'
import { assertHmrWorkspaceSnapshot, type HmrWorkspaceSnapshot } from './snapshot'

export type CreateHmrHostOptions = {
	root?: string
	chdir?: boolean
	debug?: readonly string[]
	workspaceSnapshot: HmrWorkspaceSnapshot
	snapshotPatch?: (snapshot: HmrWorkspaceSnapshot) => HmrWorkspaceSnapshot
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
	store?: {
		configFile?: string
		seedConfig?: string | false
		pluginDataDir?: string
	}
	registry?: Record<string, unknown>
	context?: Record<string, unknown>
}

export type CreateHmrHostResult = {
	root: string
	logsDir: string
	ctx: import('@pluxel/core').Context
	hmr: import('./dev/hmr/HMRService').HMRService
}

export type StartHmrHostFromConfigOptions = Omit<CreateHmrHostOptions, 'workspaceSnapshot'> & {
	configPath?: string
	profile?: string
	env?: Record<string, string | undefined>
	omitPackages?: string[]
}

export type StartHmrHostFromConfigResult = CreateHmrHostResult & {
	started: true
	snapshot: HmrWorkspaceSnapshot
	warnings: string[]
}

export type CreateHmrHostFromConfigResult = CreateHmrHostResult & {
	snapshot: HmrWorkspaceSnapshot
	warnings: string[]
}

async function prepareStore(
	root: string,
	snapshot: HmrWorkspaceSnapshot,
	store: CreateHmrHostOptions['store'],
): Promise<RuntimeStorageLayout | undefined> {
	if (!store) return undefined

	const storage = resolveRuntimeStoragePaths(root, {
		configFile: store.configFile ?? '.pluxel/hmr/config.json',
		pluginDataDir: store.pluginDataDir ?? '.pluxel/plugin-data',
	})
	await materializeProfiledFile(storage.configFile, {
		profile: snapshot.activeProfile,
		seedFile:
			store.seedConfig === false ? false : resolve(root, store.seedConfig ?? 'default.json'),
	})

	return {
		configFile: storage.configFile,
		pluginDataDir: storage.pluginDataDir,
	}
}

export async function createHmrHostFromConfig(
	opts: StartHmrHostFromConfigOptions,
): Promise<CreateHmrHostFromConfigResult> {
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

	const res = await diagnoseWorkspace({
		rootDir,
		configPath: configPathAbs,
		env,
		omitPackages,
	})
	if (res.ok === false) throw new Error(res.errors.join('\n'))

	const host = await createHmrHost({
		...hostOpts,
		root: rootDir,
		workspaceSnapshot: res.snapshot,
	})

	return { ...host, snapshot: res.snapshot, warnings: res.warnings }
}

export async function startHmrHostFromConfig(
	opts: StartHmrHostFromConfigOptions,
): Promise<StartHmrHostFromConfigResult> {
	const res = await createHmrHostFromConfig(opts)
	await res.hmr.start()
	return { ...res, started: true }
}

export { applyHmrEnvOverrides }

export async function createHmrHost(opts: CreateHmrHostOptions): Promise<CreateHmrHostResult> {
	// `@pluxel/runtime` sets process runtime to "core"; override it back to "hmr" for dev hosts.
	// This affects logger preset defaults (category/name injection) and other runtime flags.
	setPluxelRuntime('hmr')

	const root = resolve(opts.root ?? process.cwd())
	if (opts.chdir !== false) process.chdir(root)

	let snapshot = opts.workspaceSnapshot
	if (!snapshot) {
		throw new Error(
			'[hmr-host] workspaceSnapshot is required (compute it in your caller, e.g. via @pluxel/hmr/diagnose)',
		)
	}
	if (opts.snapshotPatch) snapshot = opts.snapshotPatch(snapshot)
	assertHmrWorkspaceSnapshot(snapshot)

	const storage = await prepareStore(root, snapshot, opts.store)
	let builtinsFromDist = opts.builtinsFromDist
	if (builtinsFromDist === undefined && opts.builtins === undefined) {
		builtinsFromDist = snapshot.builtinsFromDist?.length ? snapshot.builtinsFromDist : undefined
	}

	const runtimeStorage = resolveRuntimeStoragePaths(root, {
		...(storage ?? {}),
		...(opts.logsDir ? { logsDir: opts.logsDir } : {}),
		...(opts.logFile ? { logFile: opts.logFile } : {}),
	})

	const logging = opts.logging ?? true
	if (logging) {
		await mkdir(runtimeStorage.logsDir, { recursive: true })
		const base = typeof logging === 'object' ? { ...logging } : {}
		await ensurePluxelLogging({
			preset: base.preset ?? 'hmr',
			console: base.console,
			file: base.file ?? runtimeStorage.logFile,
			ui: base.ui ?? true,
			debug: base.debug ?? opts.debug ?? ['pluxel:hmr:*'],
		})
	}

	const ctx = new Context({
		debug: opts.debug ?? ['pluxel:hmr:*'],
		registry: opts.registry,
		profile: snapshot.activeProfile,
		logger: { preset: 'hmr' },
		configService: {
			mode: 'file',
			path: runtimeStorage.configFile,
		},
		pluginData: { dir: runtimeStorage.pluginDataDir },
		packageService: {
			state: { enabled: true, file: runtimeStorage.packageStateFile },
		},
		...(opts.context ?? {}),
	})

	const dev = await attachHmrRuntime(ctx, {
		cwd: root,
		workspaceSnapshot: snapshot,
		printUrls: opts.printUrls,
		warmup: opts.warmup,
		vitePlugins: opts.vitePlugins,
		deps: opts.deps,
		cjsExternal: opts.cjsExternal,
		builtinsFromDist,
	})

	if (opts.builtins?.length) {
		await ctx.loader.preloadPlugins([...opts.builtins], { strict: true, commit: true })
	}

	return { root, logsDir: runtimeStorage.logsDir, ctx, hmr: dev.hmr }
}

export async function startHmrHost(
	opts: CreateHmrHostOptions,
): Promise<CreateHmrHostResult & { started: true }> {
	const res = await createHmrHost(opts)
	await res.hmr.start()
	return { ...res, started: true }
}
