import type { Context } from '@pluxel/core'
import { runtimeDevCapabilities, type RuntimeRouteCapabilities } from './plugin-catalog'
import { isAbsolute, resolve } from 'pathe'
import { resolveModuleIdBaseDir, findRuntimeModuleId } from './internal'

export { doc } from './web/extensions'

export interface PluginUiSourceDeclaration {
	/** Authoring declaration. Runtime never consumes this path directly. */
	entryPath: string
}

export interface PluginUiModuleDeclaration {
	/**
	 * Route-neutral plugin UI bridge entry.
	 *
	 * Plugin code keeps calling `ui(...).bind(ctx)` so build-time tooling can recognize and rewrite
	 * this declaration if needed. Routes with dev capabilities can consume the source declaration directly;
	 * routes without dev capabilities fall back to packaged remote registration on `ctx.ext.ui`.
	 */
	bind(ctx: Context): () => void
}

function normalizeUiConfig(input: string | PluginUiSourceDeclaration): PluginUiSourceDeclaration {
	const entryPath =
		typeof input === 'string' ? String(input).trim() : String(input.entryPath ?? '').trim()
	return { entryPath }
}

function runtimeRoute(ctx: Context): RuntimeRouteCapabilities | undefined {
	return ctx.runtimeRoute ?? ctx.root.runtimeRoute
}

function packagedUiBinder(ctx: Context): (() => () => void) | undefined {
	const ext = (
		ctx as unknown as {
			ext?: { ui?: { remote?: { packaged?: () => () => void } } }
		}
	).ext
	const remote = ext?.ui?.remote
	if (typeof remote?.packaged !== 'function') return undefined
	return () => remote.packaged!()
}

function currentWorkingDirectory(): string {
	const proc = (globalThis as unknown as { process?: { cwd?: () => string } }).process
	return typeof proc?.cwd === 'function' ? proc.cwd() : '/'
}

function fileUrlFromPath(path: string): string {
	const normalized = path.replaceAll('\\', '/')
	const pathname = encodeURI(normalized).replaceAll('#', '%23').replaceAll('?', '%3F')
	return `file://${normalized.startsWith('/') ? '' : '/'}${pathname}`
}

export function ui(input: string | PluginUiSourceDeclaration): PluginUiModuleDeclaration {
	const config = normalizeUiConfig(input)
	if (!config.entryPath) throw new Error('[pluxel/runtime/plugin] ui(): entryPath required')

	return {
		bind(ctx: Context) {
			const sourceBinder = runtimeDevCapabilities(ctx)?.uiSource?.bind
			if (sourceBinder) return sourceBinder(ctx, config)
			const packaged = packagedUiBinder(ctx)
			if (packaged) return packaged()
			throw new Error(
				'[runtime/plugin:web-management] service unavailable. Reason: ui().bind(ctx) has no dev UI source capability and @pluxel/runtime/services/web-management is not imported. Fix: import @pluxel/runtime/services/web-management before starting the host, or remove ui(...).bind(ctx) from this plugin.',
			)
		},
	}
}

export type PluginWorkerMode = 'hmr' | 'fallback'

export type PluginWorkerSnapshot = {
	mode: PluginWorkerMode
	url: string | null
}

export type PluginWorkerDeclarationOptions = {
	external?: string[]
	fallback?: string | null
}

export type PluginWorkerBindOptions = PluginWorkerDeclarationOptions & {
	onUpdate?: (snapshot: PluginWorkerSnapshot) => void | Promise<void>
	onError?: (error: unknown) => void
}

export interface PluginWorkerBinding {
	snapshot(): PluginWorkerSnapshot
	dispose(): Promise<void>
}

export interface PluginWorkerDeclaration {
	readonly entryPath: string
	bind(ctx: Context, options?: PluginWorkerBindOptions): Promise<PluginWorkerBinding>
}

function resolvePluginFile(ctx: Context, targetPath: string): string {
	if (isAbsolute(targetPath)) return targetPath

	const pluginId = ctx.pluginInfo?.id
	if (pluginId) {
		try {
			const registryPath = findRuntimeModuleId(ctx, pluginId)
			const baseDir = registryPath ? resolveModuleIdBaseDir(registryPath) : null
			if (baseDir) return resolve(baseDir, targetPath)
		} catch {
			// Ignore registry lookup failures and fall back to cwd.
		}
	}

	return resolve(currentWorkingDirectory(), targetPath)
}

function resolveFallbackUrl(ctx: Context, fallback: string | null | undefined): string | null {
	const raw = String(fallback ?? '').trim()
	if (!raw) return null

	try {
		return new URL(raw).href
	} catch {
		return fileUrlFromPath(resolvePluginFile(ctx, raw))
	}
}

export function worker(
	entryPath: string,
	defaults: PluginWorkerDeclarationOptions = {},
): PluginWorkerDeclaration {
	const normalizedEntry = String(entryPath ?? '').trim()
	if (!normalizedEntry) {
		throw new Error('[pluxel/runtime/plugin] worker(): entryPath required')
	}

	const defaultExternal = defaults.external ? [...defaults.external] : []
	const defaultFallback = defaults.fallback ?? null

	return {
		entryPath: normalizedEntry,
		async bind(ctx: Context, options: PluginWorkerBindOptions = {}): Promise<PluginWorkerBinding> {
			const external = options.external ? [...options.external] : defaultExternal
			const fallback = options.fallback ?? defaultFallback
			const onUpdate = options.onUpdate
			const onError = options.onError
			const state: PluginWorkerSnapshot = {
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

			const workerDev = runtimeDevCapabilities(ctx)?.worker
			if (workerDev?.watch) {
				stopWatching = await workerDev.watch(ctx, normalizedEntry, {
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
