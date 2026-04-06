import { pathToFileURL } from 'node:url'
import type { Context } from '@pluxel/runtime'
import { getDevRuntimeHandles, resolveModuleIdBaseDir } from '@pluxel/runtime/internal'
import { isAbsolute, resolve } from 'pathe'

export interface HmrUiSourceDeclaration {
	/** Authoring/HMR-only declaration. Runtime never consumes this path directly. */
	entryPath: string
}

export interface HmrUiModuleDeclaration {
	/**
	 * Dev/HMR bridge entry.
	 *
	 * Plugin code keeps calling `ui(...).bind(ctx)` so build-time tooling can recognize and rewrite
	 * this declaration if needed. In dev, HMR consumes the source declaration directly; outside dev
	 * it falls back to packaged remote registration on `ctx.ext.ui`. The runtime registry only sees
	 * compiled MF artifacts, never this source entry path.
	 */
	bind(ctx: Context): () => void
}

function normalizeUiConfig(input: string | HmrUiSourceDeclaration): HmrUiSourceDeclaration {
	const entryPath =
		typeof input === 'string' ? String(input).trim() : String(input.entryPath ?? '').trim()
	return { entryPath }
}

export function ui(input: string | HmrUiSourceDeclaration): HmrUiModuleDeclaration {
	const config = normalizeUiConfig(input)
	if (!config.entryPath) throw new Error('[pluxel/hmr] ui(): entryPath required')

	return {
		bind(ctx: Context) {
			const devBinder = getDevRuntimeHandles(ctx)?.extensions?.bindUiSource
			if (devBinder) return devBinder(ctx, config)
			return ctx.ext.ui.remote.packaged()
		},
	}
}

export type HmrWorkerMode = 'hmr' | 'fallback'

export type HmrWorkerSnapshot = {
	mode: HmrWorkerMode
	url: string | null
}

export type HmrWorkerDeclarationOptions = {
	external?: string[]
	fallback?: string | null
}

export type HmrWorkerBindOptions = HmrWorkerDeclarationOptions & {
	onUpdate?: (snapshot: HmrWorkerSnapshot) => void | Promise<void>
	onError?: (error: unknown) => void
}

export interface HmrWorkerBinding {
	snapshot(): HmrWorkerSnapshot
	dispose(): Promise<void>
}

export interface HmrWorkerDeclaration {
	readonly entryPath: string
	bind(ctx: Context, options?: HmrWorkerBindOptions): Promise<HmrWorkerBinding>
}

function resolvePluginFile(ctx: Context, targetPath: string): string {
	if (isAbsolute(targetPath)) return targetPath

	const pluginId = ctx.pluginInfo?.id
	if (pluginId) {
		try {
			const registryPath = ctx.loader?.api?.registry?.findModuleIdByName?.(pluginId)
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
	defaults: HmrWorkerDeclarationOptions = {},
): HmrWorkerDeclaration {
	const normalizedEntry = String(entryPath ?? '').trim()
	if (!normalizedEntry) throw new Error('[pluxel/hmr] worker(): entryPath required')

	const defaultExternal = defaults.external?.slice() ?? []
	const defaultFallback = defaults.fallback ?? null

	return {
		entryPath: normalizedEntry,
		async bind(ctx: Context, options: HmrWorkerBindOptions = {}): Promise<HmrWorkerBinding> {
			const external = options.external?.slice() ?? defaultExternal
			const fallback = options.fallback ?? defaultFallback
			const onUpdate = options.onUpdate
			const onError = options.onError
			const state: HmrWorkerSnapshot = {
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

			const bundler = getDevRuntimeHandles(ctx)?.bundler
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
