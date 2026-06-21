import { existsSync } from 'node:fs'
import type { Context } from '@pluxel/core'
import {
	clearHmrRuntimeHandles,
	clearRuntimeModuleAdapter,
	getHmrRuntimeHandles,
	hasRuntimeModuleAdapter,
	setHmrRuntimeHandles,
	setRuntimeModuleAdapter,
} from '@pluxel/runtime/internal'
import { mergeExtensionCompilerViteConfig } from '@pluxel/runtime-dev'
import { isAbsolute, resolve } from 'pathe'
import type { InlineConfig } from 'vite'

import { assertLoaderHmrWorkspace, type LoaderHmrWorkspaceSnapshot } from './snapshot'
import { BundlerService } from './compile/bundler/BundlerService'
import type { LoaderHmrDependencyConfig } from './engine/config'
import { LoaderHmrService, type LoaderHmrConfig } from './engine/LoaderHmrService'
import { ExtensionCompilerService } from './extensions/ExtensionCompilerService'
import { applyLoaderHmrEnvOverrides } from './hmr-env'

export type InstallLoaderHmrRuntimeOptions = {
	cwd?: string
	snapshot: LoaderHmrWorkspaceSnapshot
	snapshotPatch?: (snapshot: LoaderHmrWorkspaceSnapshot) => LoaderHmrWorkspaceSnapshot
	printUrls?: boolean
	warmup?: boolean
	vite?: InlineConfig
	deps?: LoaderHmrDependencyConfig
	cjsExternal?: readonly string[]
	builtinsFromDist?: LoaderHmrConfig['builtinsFromDist']
}

export type InstallLoaderHmrRuntimeResult = {
	ctx: Context
	snapshot: LoaderHmrWorkspaceSnapshot
	hmr: LoaderHmrService
}

function uniqSorted(list: readonly string[]) {
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

/**
 * Low-level: install loader HMR into an existing `Context`.
 *
 * This is a startup-only decision and does not support switching "back" at runtime.
 * For deterministic behavior, call it before instantiating runtime services that depend on these configs.
 */
export async function installLoaderHmrRuntime(
	ctx: Context,
	options: InstallLoaderHmrRuntimeOptions,
): Promise<InstallLoaderHmrRuntimeResult> {
	const cwd = resolve(options.cwd ?? process.cwd())
	let snapshot = options.snapshot
	if (options.snapshotPatch) snapshot = options.snapshotPatch(snapshot)
	assertLoaderHmrWorkspace(snapshot)

	// One-way install: guard against accidental double install (leaks watchers/workers, can split singletons).
	if (ctx.config.loaderHmr || hasRuntimeModuleAdapter(ctx) || getHmrRuntimeHandles(ctx)) {
		throw new Error(
			'[loader-hmr] installLoaderHmrRuntime called on a Context that already has loader HMR installed',
		)
	}

	const deps: LoaderHmrDependencyConfig | undefined = options.cjsExternal?.length
		? { ...options.deps, cjsExternal: options.cjsExternal }
		: options.deps
	const builtinsFromDist = resolveBuiltinsFromDistEntries(
		cwd,
		options.builtinsFromDist ?? snapshot.builtinsFromDist,
	)

	const loaderHmr: LoaderHmrConfig = applyLoaderHmrEnvOverrides({
		roots: snapshot.watchRoots,
		printUrls: options.printUrls ?? true,
		warmup: options.warmup ?? true,
		include: snapshot.includeGlobs.length > 0 ? uniqSorted(snapshot.includeGlobs) : undefined,
		entries: snapshot.enabledEntries,
		exclude: snapshot.excludeGlobs.length > 0 ? uniqSorted(snapshot.excludeGlobs) : undefined,
		clientEntries: resolveDefaultClientEntries(cwd),
		builtinsFromDist,
		vite: options.vite,
		deps,
	})

	ctx.config.loaderHmr = loaderHmr

	const hmr = new LoaderHmrService(ctx, loaderHmr)
	setRuntimeModuleAdapter(ctx, hmr)

	const bundler = new BundlerService(ctx)
	const extensionCompilerConfig = mergeExtensionCompilerViteConfig(
		ctx.config.extensionCompiler,
		options.vite,
	)
	ctx.config.extensionCompiler = extensionCompilerConfig
	const extensionCompiler = new ExtensionCompilerService(
		ctx,
		{ viteServer: hmr.vite, enabled: true },
		extensionCompilerConfig,
	)

	// HMR runtime service configs (picked up by runtime services on first instantiation).
	ctx.config.http = { ...ctx.config.http, uiAssets: 'hmr-server' }
	ctx.config.extensionService = {
		...ctx.config.extensionService,
		enabled: true,
	}
	const extensionStore = ctx.ext.ui
	extensionStore.reconfigure(ctx.config.extensionService)
	extensionCompiler.attachStore(extensionStore)

	setHmrRuntimeHandles(ctx, {
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
		extensions: {
			bindUiSource: (ownerCtx, declaration) =>
				extensionCompiler.bindDeclaration(ownerCtx, declaration),
		},
	})

	ctx.effects.defer(() => {
		// Best-effort cleanup: we don't restore previous values, but we do ensure no leaked resources.
		clearRuntimeModuleAdapter(ctx)
		clearHmrRuntimeHandles(ctx)
		extensionCompiler.dispose()
		return bundler.dispose()
	})

	return { ctx, snapshot, hmr }
}
