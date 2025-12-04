// packages/components/src/app/ExtensionLoader.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	type CompiledExtensionModule,
	loadExtensionModule,
	unloadExtensionModule,
} from '../extension'
import { fetchExtensionManifest } from '../extension/api/manifest'
import { useQuery } from './gqty'
import { subscribePluginStatusEvents } from './plugins/statusEvents'
import { sse } from './rpc'

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

	const recomputeManifestSignature = useCallback(() => {
		const signature = Array.from(moduleCacheRef.current.values())
			.map((mod) => `${mod.pluginName}:${mod.sourceHash}`)
			.sort()
			.join('|')
		manifestSignatureRef.current = signature
	}, [])

	const ensureModuleLoaded = useCallback(async (module: CompiledExtensionModule) => {
		const cached = moduleCacheRef.current.get(module.pluginName)
		if (cached && cached.sourceHash === module.sourceHash) {
			if (cached.inflight) {
				await cached.inflight
			}
			return
		}

		const url = withCacheBusting(module.moduleUrl, module.sourceHash, module.compiledAt)
		const loadPromise = loadExtensionModule(
			module.pluginName,
			() => import(/* @vite-ignore */ url),
			module.sourceHash,
		)
		moduleCacheRef.current.set(module.pluginName, {
			...module,
			inflight: loadPromise,
		})

		try {
			await loadPromise
		} catch (error) {
			moduleCacheRef.current.delete(module.pluginName)
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
			if (loadingRef.current) return
			loadingRef.current = true
			try {
				const manifest = await fetchExtensionManifest()
				const nextSignature = manifest.modules
					.map((module) => `${module.pluginName}:${module.sourceHash}`)
					.sort()
					.join('|')
				if (
					!force &&
					manifest.version === manifestVersionRef.current &&
					nextSignature === manifestSignatureRef.current
				) {
					return
				}
				const seen = new Set<string>()
				await Promise.all(
					manifest.modules.map(async (module) => {
						seen.add(module.pluginName)
						try {
							await ensureModuleLoaded(module)
						} catch (error) {
							if (process.env.NODE_ENV !== 'production') {
								console.error('[ExtensionLoader] failed to load module', module.pluginName, error)
							}
						}
					}),
				)
				for (const name of Array.from(moduleCacheRef.current.keys())) {
					if (!seen.has(name)) {
						moduleCacheRef.current.delete(name)
						unloadExtensionModule(name)
					}
				}
				manifestVersionRef.current = manifest.version
				manifestSignatureRef.current = nextSignature
			} catch (error) {
				if (process.env.NODE_ENV !== 'production') {
					console.error('[ExtensionLoader] failed to sync manifest', error)
				}
			} finally {
				loadingRef.current = false
				recomputeManifestSignature()
			}
		},
		[ensureModuleLoaded, recomputeManifestSignature],
	)

	useEffect(() => {
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
		const stream = sse({ namespaces: ['extensions'] })
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
			stream.close()
		}
	}, [ensureModuleLoaded, query.$refetch, recomputeManifestSignature, syncManifest])

	return null
}

function withCacheBusting(url: string, hash: string, compiledAt: number): string {
	const suffix = `v=${hash}:${compiledAt}`
	return url.includes('?') ? `${url}&${suffix}` : `${url}?${suffix}`
}
