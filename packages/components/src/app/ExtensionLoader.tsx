// packages/components/src/app/ExtensionLoader.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	type BuiltinExtensionDef,
	type BuiltinExtensionKind,
	type CompiledExtensionModule,
	type ExtensionMeta,
	ExtensionErrorBoundary,
	extensionRegistry,
	initVendors,
	loadExtensionModule,
	unloadExtensionModule,
} from '../extension'
import { fetchExtensionManifest } from '../extension/api/manifest'
import { builtinComponents } from '../extension/builtin'
import { extLog } from '../extension/debug'
import { usePluginOverview } from './plugins/data'
import { subscribeInvalidations } from './data/invalidations'
import { useHmrWebClient } from './rpc'

interface ExtensionLoaderProps {
	pollInterval?: number
	onRunningPluginsChange?: (plugins: ReadonlySet<string>) => void
	/** Keep extension modules loaded even when plugins stop running. */
	unloadOnStop?: boolean
	/** Delay unload when unloadOnStop is true, to avoid flapping. */
	unloadDelayMs?: number
}

interface PluginInfo {
	name: string
	isRunning: boolean
}

interface LoadedPluginModule extends CompiledExtensionModule {
	inflight?: Promise<void>
}

const loaderState = {
	manifestVersion: 0,
	manifestSignature: '',
	loading: false,
	pendingForce: false,
	moduleCache: new Map<string, LoadedPluginModule>(),
	builtinCache: new Map<string, { sig: string; cleanup: () => void }>(),
	manifestBackoff: null as { at: number; backoffMs: number } | null,
	unloadTimers: new Map<string, number>(),
}

const DEFAULT_UNLOAD_DELAY_MS = 8_000

function recomputeLoaderSignature() {
	const moduleSig = Array.from(loaderState.moduleCache.values())
		.map((mod) => `${mod.pluginName}:${mod.sourceHash}`)
		.sort()
		.join('|')
	const builtinSig = Array.from(loaderState.builtinCache.entries())
		.map(([key, v]) => `${key}:${v.sig}`)
		.sort()
		.join('|')
	loaderState.manifestSignature = `${moduleSig}||builtins:${builtinSig}`
}

function cancelScheduledUnload(pluginName: string) {
	const timer = loaderState.unloadTimers.get(pluginName)
	if (!timer) return
	clearTimeout(timer)
	loaderState.unloadTimers.delete(pluginName)
}

function scheduleUnload(pluginName: string, delayMs: number, reason: string) {
	if (loaderState.unloadTimers.has(pluginName)) return
	const timer = setTimeout(() => {
		loaderState.unloadTimers.delete(pluginName)
		if (loaderState.moduleCache.has(pluginName)) {
			loaderState.moduleCache.delete(pluginName)
			unloadExtensionModule(pluginName)
			extLog('unloaded %s (%s)', pluginName, reason)
			recomputeLoaderSignature()
		}
	}, delayMs)
	loaderState.unloadTimers.set(pluginName, timer)
}

export function ExtensionLoader({
	pollInterval = 5000,
	onRunningPluginsChange,
	unloadOnStop = false,
	unloadDelayMs = DEFAULT_UNLOAD_DELAY_MS,
}: ExtensionLoaderProps) {
	useEffect(() => {
		if (typeof window === 'undefined') return
		if (process.env.NODE_ENV !== 'production') {
			console.log('[ExtensionLoader] mounted', {
				origin: window.location.origin,
				pathname: window.location.pathname,
			})
		}
	}, [])

	const stream = useHmrWebClient().sse
	const overviewState = usePluginOverview()
	const rawStatuses = overviewState.overview?.status?.statuses ?? []

	const derivedPlugins: PluginInfo[] = useMemo(() => {
		return rawStatuses
			.slice()
			.sort((a, b) => {
				const an = typeof a?.name === 'string' ? a.name : ''
				const bn = typeof b?.name === 'string' ? b.name : ''
				return an.localeCompare(bn)
			})
			.filter(
				(entry): entry is NonNullable<typeof entry> & { name: string } =>
					typeof entry?.name === 'string' && entry.name.trim().length > 0,
			)
			.map((entry) => ({
				name: entry.name.trim(),
				isRunning: Boolean(entry.isRunning),
			}))
	}, [rawStatuses])

	const signature = useMemo(
		() => derivedPlugins.map((p) => `${p.name}:${p.isRunning ? 1 : 0}`).join('|'),
		[derivedPlugins],
	)

	const cachedRef = useRef<{ key: string; plugins: PluginInfo[] }>({
		key: signature,
		plugins: derivedPlugins,
	})

	const [stablePlugins, setStablePlugins] = useState<PluginInfo[]>(derivedPlugins)
	const isLoading = overviewState.isLoading === true
	const hasError = !overviewState.hasSnapshot && Boolean(overviewState.error)

	useEffect(() => {
		// IMPORTANT: during refetch/errors, GQty may temporarily surface empty arrays.
		// Never overwrite the stable snapshot with an "empty flash" (would break plugin pages).
		if (isLoading || hasError) return
		if (cachedRef.current.key === signature) {
			setStablePlugins(cachedRef.current.plugins)
			return
		}
		const cloned = derivedPlugins.map((plugin) => ({ ...plugin }))
		cachedRef.current = { key: signature, plugins: cloned }
		setStablePlugins(cloned)
	}, [derivedPlugins, hasError, signature, isLoading])

	const effectivePlugins = isLoading || hasError ? cachedRef.current.plugins : stablePlugins
	const effectiveSignature = isLoading || hasError ? cachedRef.current.key : signature

	useEffect(() => {
		if (!onRunningPluginsChange) return
		const next = new Set<string>()
		for (const plugin of effectivePlugins) {
			if (plugin.isRunning && plugin.name) {
				next.add(plugin.name)
			}
		}
		onRunningPluginsChange(next)
	}, [effectivePlugins, onRunningPluginsChange])

	const shouldSkipManifestSync = useCallback(() => {
		const state = loaderState.manifestBackoff
		if (!state) return false
		return Date.now() - state.at < state.backoffMs
	}, [])

	const recomputeManifestSignature = useCallback(recomputeLoaderSignature, [])

	const syncBuiltins = useCallback((builtins?: BuiltinExtensionDef[]) => {
		extensionRegistry.batch(() => {
			const next = Array.isArray(builtins) ? builtins : []
			const seen = new Set<string>()
			const fallbackSig = (
				def: BuiltinExtensionDef,
				meta: { kind: string; pluginName: string; point: string; id: string },
			) => {
				try {
					return JSON.stringify(def)
				} catch {
					return `${meta.kind}:${meta.pluginName}:${meta.point}:${meta.id}`
				}
			}

			for (const def of next) {
				if (!def || typeof def !== 'object') continue
				const pluginName = typeof (def as any).pluginName === 'string' ? (def as any).pluginName : ''
				const point = typeof (def as any).point === 'string' ? (def as any).point : ''
				const id = typeof (def as any).id === 'string' ? (def as any).id : ''
				const kind = typeof (def as any).kind === 'string' ? (def as any).kind : ''
				if (!pluginName || !point || !id || !kind) continue

				const runtimeId = `${pluginName}:builtin:${point}:${id}`
				seen.add(runtimeId)

				const sig = fallbackSig(def, { kind, pluginName, point, id })

				const cached = loaderState.builtinCache.get(runtimeId)
				if (cached && cached.sig === sig) continue
				if (cached) {
					try {
						cached.cleanup()
					} catch {}
					loaderState.builtinCache.delete(runtimeId)
				}

				const meta: ExtensionMeta = {
					...((def as any).meta ?? {}),
					id: runtimeId,
					pluginName,
					priority: typeof (def as any).priority === 'number' ? (def as any).priority : 0,
					requireRunning: (def as any).requireRunning ?? true,
				}

				const Component = builtinComponents[kind as BuiltinExtensionKind]
				if (!Component) {
					extLog('skip builtin kind=%s (id=%s)', kind, runtimeId)
					continue
				}

				const render = () => (
					<ExtensionErrorBoundary
						pluginName={pluginName}
						extensionId={runtimeId}
						point={point}
						fallback={
							process.env.NODE_ENV !== 'production'
								? ({ error }) => (
										<div
											style={{
												padding: 8,
												borderRadius: 8,
												border: '1px solid rgba(255, 0, 0, 0.25)',
												background: 'rgba(255, 0, 0, 0.06)',
												fontSize: 12,
												lineHeight: 1.4,
											}}
										>
											<div style={{ fontWeight: 600 }}>
												Builtin render failed: {pluginName} · {point}
											</div>
											<div style={{ opacity: 0.85 }}>
												{error?.message ?? String(error ?? 'unknown error')}
											</div>
										</div>
									)
								: null
						}
					>
						<Component def={def as any} />
					</ExtensionErrorBoundary>
				)

				const cleanup = extensionRegistry.register(point as any, { meta, render })
				loaderState.builtinCache.set(runtimeId, { sig, cleanup })
			}

			for (const [key, cached] of Array.from(loaderState.builtinCache.entries())) {
				if (seen.has(key)) continue
				try {
					cached.cleanup()
				} catch {}
				loaderState.builtinCache.delete(key)
			}
		})
	}, [])

	// 插件停止后是否卸载扩展模块（避免频繁加载/卸载可延迟执行）
	useEffect(() => {
		if (!unloadOnStop) return
		if (!statusReadyRef.current) return
		const delayMs = Math.max(0, unloadDelayMs)
		const running = new Set<string>()
		for (const plugin of effectivePlugins) {
			if (plugin.isRunning && plugin.name) {
				running.add(plugin.name)
			}
		}

		for (const name of Array.from(loaderState.moduleCache.keys())) {
			if (!running.has(name)) {
				scheduleUnload(name, delayMs, 'plugin-stop')
			} else {
				cancelScheduledUnload(name)
			}
		}
		recomputeManifestSignature()
	}, [effectivePlugins, recomputeManifestSignature, unloadDelayMs, unloadOnStop])

	const ensureModuleLoaded = useCallback(async (module: CompiledExtensionModule) => {
		const cached = loaderState.moduleCache.get(module.pluginName)
		if (cached && cached.sourceHash === module.sourceHash) {
			if (cached.inflight) {
				await cached.inflight
			}
			cancelScheduledUnload(module.pluginName)
			return
		}

		const url = withCacheBusting(module.moduleUrl, module.sourceHash, module.compiledAt)
		if (process.env.NODE_ENV !== 'production') {
			console.log('[ExtensionLoader] importing', {
				pluginName: module.pluginName,
				sourceHash: module.sourceHash,
				url,
			})
		}
		extLog('loading %s@%s', module.pluginName, module.sourceHash)
		const loadPromise = loadExtensionModule(
			module.pluginName,
			() => dynamicImport(url),
			module.sourceHash,
		)
		loaderState.moduleCache.set(module.pluginName, {
			...module,
			inflight: loadPromise,
		})

		try {
			await loadPromise
			cancelScheduledUnload(module.pluginName)
			if (process.env.NODE_ENV !== 'production') {
				console.log('[ExtensionLoader] loaded', {
					pluginName: module.pluginName,
					sourceHash: module.sourceHash,
				})
			}
			extLog('loaded %s@%s', module.pluginName, module.sourceHash)
		} catch (error) {
			loaderState.moduleCache.delete(module.pluginName)
			extLog('failed to load %s: %o', module.pluginName, error)
			throw error
		} finally {
			const latest = loaderState.moduleCache.get(module.pluginName)
			if (latest && latest.sourceHash === module.sourceHash) {
				latest.inflight = undefined
			}
		}
	}, [])

	const syncManifest = useCallback(
		async (force?: boolean) => {
			if (!force && shouldSkipManifestSync()) return
			if (loaderState.loading) {
				if (force) loaderState.pendingForce = true
				return
			}
			loaderState.loading = true
			try {
				extLog('fetching manifest')
				const manifest = await fetchExtensionManifest()
				loaderState.manifestBackoff = null
				if (process.env.NODE_ENV !== 'production') {
					console.log('[ExtensionLoader] fetched manifest', {
						version: manifest.version,
						modules: manifest.modules.map((m) => ({
							pluginName: m.pluginName,
							sourceHash: m.sourceHash,
							moduleUrl: m.moduleUrl,
						})),
					})
				}
				extLog('fetched manifest v%d', manifest.version)

				const computeSignature = (payload: typeof manifest) => {
					const modulesSig = payload.modules
						.map((module) => `${module.pluginName}:${module.sourceHash}`)
						.sort()
						.join('|')
					const builtinsSig = (payload.builtins ?? [])
						.map((b) => {
							try {
								return JSON.stringify(b)
							} catch {
								const pluginName = (b as any)?.pluginName ?? ''
								const point = (b as any)?.point ?? ''
								const id = (b as any)?.id ?? ''
								const kind = (b as any)?.kind ?? ''
								return `${kind}:${pluginName}:${point}:${id}`
							}
						})
						.sort()
						.join('|')
					return `${modulesSig}||builtins:${builtinsSig}`
				}

				const applyManifest = async (
					payload: typeof manifest,
					allowRetry: boolean,
				): Promise<{ signature: string; version: number; moduleCount: number; skipped: boolean }> => {
					const nextSignature = computeSignature(payload)
					if (
						!force &&
						payload.version === loaderState.manifestVersion &&
						nextSignature === loaderState.manifestSignature
					) {
						return {
							signature: nextSignature,
							version: payload.version,
							moduleCount: payload.modules.length,
							skipped: true,
						}
					}

					const failedPlugins: string[] = []
					const seen = new Set<string>()
					await Promise.all(
						payload.modules.map(async (module) => {
							seen.add(module.pluginName)
							try {
								await ensureModuleLoaded(module)
							} catch (error) {
								failedPlugins.push(module.pluginName)
								console.error('[ExtensionLoader] failed to load module', module.pluginName, error)
							}
						}),
					)

					syncBuiltins(payload.builtins)

					// 自愈：如果加载失败（比如服务端删除了陈旧 hash 并触发重新编译），立刻刷新 manifest 再重试一次
					if (allowRetry && failedPlugins.length) {
						const retryManifest = await fetchExtensionManifest()
						const retrySignature = computeSignature(retryManifest)
						if (
							retryManifest.version !== payload.version ||
							retrySignature !== nextSignature
						) {
							return applyManifest(retryManifest, false)
						}
					}

					for (const name of Array.from(loaderState.moduleCache.keys())) {
						if (!seen.has(name)) {
							cancelScheduledUnload(name)
							loaderState.moduleCache.delete(name)
							unloadExtensionModule(name)
						}
					}

					return {
						signature: nextSignature,
						version: payload.version,
						moduleCount: payload.modules.length,
						skipped: false,
					}
				}

				const applied = await applyManifest(manifest, true)
				if (applied.skipped) return

				loaderState.manifestVersion = applied.version
				loaderState.manifestSignature = applied.signature
				extLog('synced manifest v%d (%d modules)', applied.version, applied.moduleCount)
			} catch (error) {
				const now = Date.now()
				const prev = loaderState.manifestBackoff
				const backoffMs = prev ? Math.min(prev.backoffMs * 2, 60_000) : 2_000
				loaderState.manifestBackoff = { at: now, backoffMs }
				console.error('[ExtensionLoader] failed to sync manifest', error)
			} finally {
				loaderState.loading = false
				recomputeManifestSignature()
				if (loaderState.pendingForce) {
					loaderState.pendingForce = false
					queueMicrotask(() => {
						void syncManifest(true)
					})
				}
			}
		},
		[ensureModuleLoaded, recomputeManifestSignature, shouldSkipManifestSync, syncBuiltins],
	)

	useEffect(() => {
		// 确保扩展运行前共享 vendors 已挂载（防止页面初始化较慢时未注入 React/Mantine）
		initVendors()

		void syncManifest()
		if (pollInterval <= 0) return
		const timer = setInterval(() => {
			void syncManifest()
		}, pollInterval)
		return () => clearInterval(timer)
	}, [pollInterval, syncManifest])

	useEffect(() => {
		if (typeof window === 'undefined') {
			return
		}
		let inflight = false
		let pending = false
		const triggerSync = () => {
			if (inflight) {
				pending = true
				return
			}
			inflight = true
			void syncManifest()
				.catch(() => {})
				.finally(() => {
					inflight = false
					if (pending) {
						pending = false
						triggerSync()
					}
				})
		}
		const unsubscribe = subscribeInvalidations((event) => {
			if (event.topic !== 'plugin-status') return
			triggerSync()
		})
		const off = stream.extensions.on(({ payload }) => {
			if (!payload) return
			if (payload.type === 'sync') {
				if (payload.version > loaderState.manifestVersion) {
					void syncManifest(true)
				}
				loaderState.manifestVersion = payload.version
				return
			}
			if (payload.version <= loaderState.manifestVersion) {
				return
			}
			loaderState.manifestVersion = payload.version

			if (payload.type === 'update') {
				void ensureModuleLoaded({
					pluginName: payload.pluginName,
					moduleUrl: payload.moduleUrl,
					sourceHash: payload.sourceHash,
					compiledAt: payload.compiledAt,
				})
					.then(recomputeManifestSignature)
					.catch((error) => {
						if (process.env.NODE_ENV !== 'production') {
							console.error('[ExtensionLoader] failed to refresh module', payload.pluginName, error)
						}
					})
			} else if (payload.type === 'remove') {
				if (loaderState.moduleCache.has(payload.pluginName)) {
					cancelScheduledUnload(payload.pluginName)
					loaderState.moduleCache.delete(payload.pluginName)
					unloadExtensionModule(payload.pluginName)
					recomputeManifestSignature()
				}
			}
		})
		return () => {
			unsubscribe()
			off()
		}
	}, [ensureModuleLoaded, recomputeManifestSignature, stream, syncManifest])

	return null
}

function withCacheBusting(url: string, hash: string, compiledAt: number): string {
	const suffix = `v=${hash}:${compiledAt}`
	return url.includes('?') ? `${url}&${suffix}` : `${url}?${suffix}`
}

const dynamicImport = (path: string) => import(/* @vite-ignore */ path)
