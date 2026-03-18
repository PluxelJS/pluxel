import type { Context } from '@pluxel/core'
import {
	clearDevRuntimeHandles,
	clearRuntimeModuleAdapter,
	createHmrModuleRuntimeAdapter,
	getDevRuntimeHandles,
	hasRuntimeModuleAdapter,
	setDevRuntimeHandles,
	setRuntimeModuleAdapter,
} from '@pluxel/runtime/internal'
import { isAbsolute, resolve } from 'pathe'
import { type Plugin as VitePlugin } from 'vite'

import type { HmrWorkspaceSnapshot } from '../snapshot'
import { assertHmrWorkspaceSnapshot } from '../snapshot'
import { BundlerService } from './compile/bundler/BundlerService'
import type { HMRDependencyConfig } from './hmr/config'
import { HMRService, type HMRConfig } from './hmr/HMRService'
import { ExtensionCompilerService } from './extensions/ExtensionCompilerService'
import { applyHmrEnvOverrides } from './runtime'

export type AttachHmrRuntimeOptions = {
	cwd?: string
	workspaceSnapshot: HmrWorkspaceSnapshot
	snapshotPatch?: (snapshot: HmrWorkspaceSnapshot) => HmrWorkspaceSnapshot
	printUrls?: boolean
	warmup?: boolean
	vitePlugins?: VitePlugin[]
	deps?: HMRDependencyConfig
	cjsExternal?: readonly string[]
	builtinsFromDist?: HMRConfig['builtinsFromDist']
}

export type AttachHmrRuntimeResult = {
	ctx: Context
	snapshot: HmrWorkspaceSnapshot
	hmr: HMRService
}

function uniqSorted(list: readonly string[]) {
	return [...new Set(list)].sort((a, b) => a.localeCompare(b))
}

function resolveBuiltinsFromDistEntries(
	cwd: string,
	list: HMRConfig['builtinsFromDist'],
): HMRConfig['builtinsFromDist'] {
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

/**
 * Low-level: wire HMR into an existing `Context`.
 *
 * This is a startup-only decision and does not support switching "back" at runtime.
 * For deterministic behavior, call it before instantiating runtime services that depend on these configs.
 */
export async function attachHmrRuntime(
	ctx: Context,
	options: AttachHmrRuntimeOptions,
): Promise<AttachHmrRuntimeResult> {
	const cwd = resolve(options.cwd ?? process.cwd())
	let snapshot = options.workspaceSnapshot
	if (options.snapshotPatch) snapshot = options.snapshotPatch(snapshot)
	assertHmrWorkspaceSnapshot(snapshot)

	// One-way attach: guard against accidental double-attach (leaks watchers/workers, can split singletons).
	if (ctx.config.hmrService || hasRuntimeModuleAdapter(ctx) || getDevRuntimeHandles(ctx)) {
		throw new Error('[hmr] attachHmrRuntime called on a Context that already has HMR attached')
	}

	const deps: HMRDependencyConfig | undefined = options.cjsExternal?.length
		? { ...(options.deps ?? {}), cjsExternal: options.cjsExternal }
		: options.deps
	const builtinsFromDist = resolveBuiltinsFromDistEntries(
		cwd,
		options.builtinsFromDist ?? snapshot.builtinsFromDist,
	)

	const hmrService: HMRConfig = applyHmrEnvOverrides({
		roots: snapshot.watchRoots,
		printUrls: options.printUrls ?? true,
		warmup: options.warmup ?? true,
		include: snapshot.includeGlobs.length ? uniqSorted(snapshot.includeGlobs) : undefined,
		entries: snapshot.enabledEntries,
		exclude: snapshot.excludeGlobs.length ? uniqSorted(snapshot.excludeGlobs) : undefined,
		builtinsFromDist,
		vitePlugins: options.vitePlugins,
		deps,
	})

	ctx.config.hmrService = hmrService

	const hmr = new HMRService(ctx, hmrService)
	setRuntimeModuleAdapter(ctx, createHmrModuleRuntimeAdapter(hmr))

	const bundler = new BundlerService(ctx)
	const extensionCompiler = new ExtensionCompilerService(
		ctx,
		{ hmr, bundler, enabled: true },
		ctx.config.extensionCompiler,
	)

	// Dev-only runtime service configs (picked up by runtime services on first instantiation).
	ctx.config.http = { ...(ctx.config.http ?? {}), uiAssets: 'dev-server' }
	ctx.config.extensionService = {
		...(ctx.config.extensionService ?? {}),
		enabled: true,
		mode: 'compile',
		compiler: extensionCompiler,
	}

	setDevRuntimeHandles(ctx, {
		hmr: {
			api: hmr.api,
			executeFiles: (files, keepOrder) => hmr.executeFiles(files, keepOrder !== false),
		},
		bundler: {
			watchTinypoolWorker: (ownerCtx, tsEntry, bundlerOptions) =>
				bundler.watchTinypoolWorker(ownerCtx, tsEntry, {
					...bundlerOptions,
					vite: hmr.vite,
				}),
		},
	})

	ctx.effects.defer(() => {
		// Best-effort cleanup: we don't restore previous values, but we do ensure no leaked resources.
		clearRuntimeModuleAdapter(ctx)
		if (ctx.config.extensionService && typeof ctx.config.extensionService === 'object') {
			;(ctx.config.extensionService as any).compiler = null
		}
		clearDevRuntimeHandles(ctx)
		extensionCompiler.dispose()
		return bundler.dispose()
	})

	return { ctx, snapshot, hmr }
}

export async function startHmrRuntime(
	ctx: Context,
	options: AttachHmrRuntimeOptions,
): Promise<AttachHmrRuntimeResult & { started: true }> {
	const res = await attachHmrRuntime(ctx, options)
	await res.hmr.start()
	return { ...res, started: true }
}

