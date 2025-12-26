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
import { useQuery } from './gqty'
import { subscribePluginStatusEvents } from './plugins/statusEvents'
import { useSseClient } from './rpc'

interface ExtensionLoaderProps {
	pollInterval?: number
	onRunningPluginsChange?: (plugins: ReadonlySet<string>) => void
}

interface PluginInfo {
	name: string
	isRunning: boolean
}

interface LoadedPluginModule extends CompiledExtensionModule {
	inflight?: Promise<void>
}

export function ExtensionLoader({
	pollInterval = 5000,
	onRunningPluginsChange,
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

	const stream = useSseClient({ namespaces: ['extensions'] })
	const query = useQuery({
		refetchOnWindowVisible: false,
		fetchInBackground: true,
		prepare: ({ query }) => {
			query.pluginStatus?.statuses?.forEach((status) => {
				status?.name
				status?.isRunning
			})
		},
	})

	const rawStatuses = query.pluginStatus?.statuses ?? []

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
	const isLoading = query.$state.isLoading === true || query.$state.isFetching === true

	useEffect(() => {
		if (isLoading) return
		if (cachedRef.current.key === signature) {
			setStablePlugins(cachedRef.current.plugins)
			return
		}
		const cloned = derivedPlugins.map((plugin) => ({ ...plugin }))
		cachedRef.current = { key: signature, plugins: cloned }
		setStablePlugins(cloned)
	}, [derivedPlugins, signature, isLoading])

	const effectivePlugins = isLoading ? cachedRef.current.plugins : stablePlugins

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

	const manifestVersionRef = useRef(0)
	const manifestSignatureRef = useRef('')
	const loadingRef = useRef(false)
	const moduleCacheRef = useRef<Map<string, LoadedPluginModule>>(new Map())
	const builtinCacheRef = useRef<Map<string, { sig: string; cleanup: () => void }>>(new Map())
	const manifestBackoffRef = useRef<{ at: number; backoffMs: number } | null>(null)

	const shouldSkipManifestSync = useCallback(() => {
		const state = manifestBackoffRef.current
		if (!state) return false
		return Date.now() - state.at < state.backoffMs
	}, [])

	const recomputeManifestSignature = useCallback(() => {
		const moduleSig = Array.from(moduleCacheRef.current.values())
			.map((mod) => `${mod.pluginName}:${mod.sourceHash}`)
			.sort()
			.join('|')
		const builtinSig = Array.from(builtinCacheRef.current.entries())
			.map(([key, v]) => `${key}:${v.sig}`)
			.sort()
			.join('|')
		manifestSignatureRef.current = `${moduleSig}||builtins:${builtinSig}`
	}, [])

	const syncBuiltins = useCallback((builtins?: BuiltinExtensionDef[]) => {
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

			const cached = builtinCacheRef.current.get(runtimeId)
			if (cached && cached.sig === sig) continue
			if (cached) {
				try {
					cached.cleanup()
				} catch {}
				builtinCacheRef.current.delete(runtimeId)
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

			const render = (ctx: any) => (
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
					<Component ctx={ctx} def={def as any} />
				</ExtensionErrorBoundary>
			)

			const cleanup = extensionRegistry.register(point as any, { meta, render })
			builtinCacheRef.current.set(runtimeId, { sig, cleanup })
		}

		for (const [key, cached] of Array.from(builtinCacheRef.current.entries())) {
			if (seen.has(key)) continue
			try {
				cached.cleanup()
			} catch {}
			builtinCacheRef.current.delete(key)
		}
	}, [])

	// 如果插件已停止运行，主动卸载其扩展模块，避免 UI 继续渲染
	useEffect(() => {
		const running = new Set<string>()
		for (const plugin of effectivePlugins) {
			if (plugin.isRunning && plugin.name) {
				running.add(plugin.name)
			}
		}

		let removed = false
		for (const name of Array.from(moduleCacheRef.current.keys())) {
			if (!running.has(name)) {
				moduleCacheRef.current.delete(name)
				unloadExtensionModule(name)
				extLog('unloaded %s due to stop', name)
				removed = true
			}
		}
		if (removed) {
			recomputeManifestSignature()
		}
	}, [effectivePlugins, recomputeManifestSignature])

	const ensureModuleLoaded = useCallback(async (module: CompiledExtensionModule) => {
		const cached = moduleCacheRef.current.get(module.pluginName)
		if (cached && cached.sourceHash === module.sourceHash) {
			if (cached.inflight) {
				await cached.inflight
			}
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
		moduleCacheRef.current.set(module.pluginName, {
			...module,
			inflight: loadPromise,
		})

		try {
			await loadPromise
			if (process.env.NODE_ENV !== 'production') {
				console.log('[ExtensionLoader] loaded', {
					pluginName: module.pluginName,
					sourceHash: module.sourceHash,
				})
			}
			extLog('loaded %s@%s', module.pluginName, module.sourceHash)
		} catch (error) {
			moduleCacheRef.current.delete(module.pluginName)
			extLog('failed to load %s: %o', module.pluginName, error)
			throw error
		} finally {
			const latest = moduleCacheRef.current.get(module.pluginName)
			if (latest && latest.sourceHash === module.sourceHash) {
				latest.inflight = undefined
			}
		}
	}, [])

	const syncManifest = useCallback(
		async (force?: boolean) => {
			if (!force && shouldSkipManifestSync()) return
			if (loadingRef.current) return
			loadingRef.current = true
			try {
				extLog('fetching manifest')
				const manifest = await fetchExtensionManifest()
				manifestBackoffRef.current = null
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
						payload.version === manifestVersionRef.current &&
						nextSignature === manifestSignatureRef.current
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

					for (const name of Array.from(moduleCacheRef.current.keys())) {
						if (!seen.has(name)) {
							moduleCacheRef.current.delete(name)
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

				manifestVersionRef.current = applied.version
				manifestSignatureRef.current = applied.signature
				extLog('synced manifest v%d (%d modules)', applied.version, applied.moduleCount)
			} catch (error) {
				const now = Date.now()
				const prev = manifestBackoffRef.current
				const backoffMs = prev ? Math.min(prev.backoffMs * 2, 60_000) : 2_000
				manifestBackoffRef.current = { at: now, backoffMs }
				console.error('[ExtensionLoader] failed to sync manifest', error)
			} finally {
				loadingRef.current = false
				recomputeManifestSignature()
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
		const triggerRefetch = () => {
			// 遇到错误就停掉“自动刷新”，避免一直刷屏打后端
			if (query.$state.error) return
			if (inflight) {
				pending = true
				return
			}
			inflight = true
			void query
				.$refetch(true)
				.catch(() => {})
				.finally(() => {
					inflight = false
					if (pending) {
						pending = false
						triggerRefetch()
					}
				})
			void syncManifest()
		}
		const unsubscribe = subscribePluginStatusEvents(triggerRefetch)
		const off = stream.extensions.on(({ payload }) => {
			if (!payload) return
			if (payload.type === 'sync') {
				if (payload.version > manifestVersionRef.current) {
					void syncManifest(true)
				}
				manifestVersionRef.current = payload.version
				return
			}
			if (payload.version <= manifestVersionRef.current) {
				return
			}
			manifestVersionRef.current = payload.version

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
				if (moduleCacheRef.current.has(payload.pluginName)) {
					moduleCacheRef.current.delete(payload.pluginName)
					unloadExtensionModule(payload.pluginName)
					recomputeManifestSignature()
				}
			}
		})
		return () => {
			unsubscribe()
			off()
		}
	}, [ensureModuleLoaded, query.$refetch, recomputeManifestSignature, stream, syncManifest])

	return null
}

function withCacheBusting(url: string, hash: string, compiledAt: number): string {
	const suffix = `v=${hash}:${compiledAt}`
	return url.includes('?') ? `${url}&${suffix}` : `${url}?${suffix}`
}

const dynamicImport = (path: string) => import(/* @vite-ignore */ path)
