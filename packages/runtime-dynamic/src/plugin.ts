import { pathToFileURL } from 'node:url'
import type { Context } from '@pluxel/runtime'
import { getHmrRuntimeHandles, resolveModuleIdBaseDir } from '@pluxel/runtime/internal'
import { isAbsolute, resolve } from 'pathe'

export interface LoaderHmrUiSourceDeclaration {
	/** Authoring/hmr-only declaration. Runtime never consumes this path directly. */
	entryPath: string
}

export interface LoaderHmrUiModuleDeclaration {
	/**
	 * Loader HMR bridge entry.
	 *
	 * Plugin code keeps calling `ui(...).bind(ctx)` so build-time tooling can recognize and rewrite
	 * this declaration if needed. In HMR mode, the loader consumes the source declaration directly; outside HMR
	 * it falls back to packaged remote registration on `ctx.ext.ui`. The runtime registry only sees
	 * compiled MF artifacts, never this source entry path.
	 */
	bind(ctx: Context): () => void
}

function normalizeUiConfig(
	input: string | LoaderHmrUiSourceDeclaration,
): LoaderHmrUiSourceDeclaration {
	const entryPath =
		typeof input === 'string' ? String(input).trim() : String(input.entryPath ?? '').trim()
	return { entryPath }
}

export function ui(input: string | LoaderHmrUiSourceDeclaration): LoaderHmrUiModuleDeclaration {
	const config = normalizeUiConfig(input)
	if (!config.entryPath) throw new Error('[pluxel/runtime-dynamic/plugin] ui(): entryPath required')

	return {
		bind(ctx: Context) {
			const hmrBinder = getHmrRuntimeHandles(ctx)?.extensions?.bindUiSource
			if (hmrBinder) return hmrBinder(ctx, config)
			return ctx.ext.ui.remote.packaged()
		},
	}
}

export type LoaderHmrWorkerMode = 'hmr' | 'fallback'

export type LoaderHmrWorkerSnapshot = {
	mode: LoaderHmrWorkerMode
	url: string | null
}

export type LoaderHmrWorkerDeclarationOptions = {
	external?: string[]
	fallback?: string | null
}

export type LoaderHmrWorkerBindOptions = LoaderHmrWorkerDeclarationOptions & {
	onUpdate?: (snapshot: LoaderHmrWorkerSnapshot) => void | Promise<void>
	onError?: (error: unknown) => void
}

export interface LoaderHmrWorkerBinding {
	snapshot(): LoaderHmrWorkerSnapshot
	dispose(): Promise<void>
}

export interface LoaderHmrWorkerDeclaration {
	readonly entryPath: string
	bind(ctx: Context, options?: LoaderHmrWorkerBindOptions): Promise<LoaderHmrWorkerBinding>
}

function resolvePluginFile(ctx: Context, targetPath: string): string {
	if (isAbsolute(targetPath)) return targetPath

	const pluginId = ctx.pluginInfo?.id
	if (pluginId) {
		try {
			const loaderApi = (
				ctx as unknown as {
					loader?: {
						api?: { registry?: { findModuleIdByName?: (name: string) => string | undefined } }
					}
				}
			).loader?.api
			const registryPath =
				ctx.registry.getRuntimeModuleId(pluginId) ??
				loaderApi?.registry?.findModuleIdByName?.(pluginId)
			const baseDir = registryPath ? resolveModuleIdBaseDir(registryPath) : null
			if (baseDir) return resolve(baseDir, targetPath)
		} catch {
			// Ignore registry lookup failures and fall back to cwd.
		}
	}

	return resolve(process.cwd(), targetPath)
}

function resolveFallbackUrl(ctx: Context, fallback: string | null | undefined): string | null {
	const raw = String(fallback ?? '').trim()
	if (!raw) return null

	try {
		return new URL(raw).href
	} catch {
		return pathToFileURL(resolvePluginFile(ctx, raw)).href
	}
}

export function worker(
	entryPath: string,
	defaults: LoaderHmrWorkerDeclarationOptions = {},
): LoaderHmrWorkerDeclaration {
	const normalizedEntry = String(entryPath ?? '').trim()
	if (!normalizedEntry) {
		throw new Error('[pluxel/runtime-dynamic/plugin] worker(): entryPath required')
	}

	const defaultExternal = defaults.external ? [...defaults.external] : []
	const defaultFallback = defaults.fallback ?? null

	return {
		entryPath: normalizedEntry,
		async bind(
			ctx: Context,
			options: LoaderHmrWorkerBindOptions = {},
		): Promise<LoaderHmrWorkerBinding> {
			const external = options.external ? [...options.external] : defaultExternal
			const fallback = options.fallback ?? defaultFallback
			const onUpdate = options.onUpdate
			const onError = options.onError
			const state: LoaderHmrWorkerSnapshot = {
				mode: 'fallback',
				url: resolveFallbackUrl(ctx, fallback),
			}

			let disposed = false
			let stopWatching: (() => Promise<void>) | null = null

			const release = async (): Promise<void> => {
				if (disposed) return
				disposed = true
				const disposeWatcher = stopWatching
				stopWatching = null
				if (!disposeWatcher) return
				await disposeWatcher()
			}

			const emit = async (): Promise<void> => {
				if (!onUpdate) return
				await onUpdate({ ...state })
			}

			const bundler = getHmrRuntimeHandles(ctx)?.bundler
			if (bundler?.watchTinypoolWorker) {
				stopWatching = await bundler.watchTinypoolWorker(ctx, normalizedEntry, {
					external,
					onError,
					onUpdate: async (workerUrl) => {
						state.mode = 'hmr'
						state.url = workerUrl
						await emit()
					},
				})
			} else {
				await emit()
			}

			const guard = ctx.effects.defer(() => {
				void release()
			})

			return {
				snapshot() {
					return { ...state }
				},
				async dispose() {
					guard.dispose()
					await release()
				},
			}
		},
	}
}
