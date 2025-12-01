// packages/components/src/app/ExtensionLoader.tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type AggregatedPluginModule, applyExtensionBundle } from '../extension'
import { fetchExtensionManifest } from '../extension/api/manifest'
import { useQuery } from './gqty'
import { subscribePluginStatusEvents } from './plugins/statusEvents'

interface ExtensionLoaderProps {
	pollInterval?: number
	onRunningPluginsChange?: (plugins: ReadonlySet<string>) => void
}

interface PluginInfo {
	name: string
	isRunning: boolean
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

	const bundleVersionRef = useRef(0)
	const loadingRef = useRef(false)

	const loadBundle = useCallback(async () => {
		if (loadingRef.current) return
		loadingRef.current = true
		try {
			const manifest = await fetchExtensionManifest()
			if (!manifest.bundleUrl) {
				bundleVersionRef.current = manifest.version
				return
			}
			if (manifest.version === bundleVersionRef.current) return
			const cacheSuffix = manifest.sourceHash || String(manifest.version)
			const url = manifest.bundleUrl.includes('?')
				? `${manifest.bundleUrl}&v=${cacheSuffix}`
				: `${manifest.bundleUrl}?v=${cacheSuffix}`
			const mod = (await import(/* @vite-ignore */ url)) as {
				plugins?: AggregatedPluginModule[]
				default?: AggregatedPluginModule[]
			}
			const payload = (mod.plugins ?? mod.default ?? []) as AggregatedPluginModule[]
			await applyExtensionBundle(payload)
			bundleVersionRef.current = manifest.version
		} catch (error) {
			if (process.env.NODE_ENV !== 'production') {
				console.error('[ExtensionLoader] failed to load bundle', error)
			}
		} finally {
			loadingRef.current = false
		}
	}, [])

	useEffect(() => {
		void loadBundle()
		if (pollInterval <= 0) return
		const timer = setInterval(() => {
			void loadBundle()
		}, pollInterval)
		return () => clearInterval(timer)
	}, [loadBundle, pollInterval])

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
			void loadBundle()
		}
		const unsubscribe = subscribePluginStatusEvents(triggerRefetch)
		const events = new EventSource('/api/extensions/events')
		events.onmessage = (event) => {
			const next = Number(event.data)
			if (!Number.isNaN(next) && next !== bundleVersionRef.current) {
				void loadBundle()
			}
		}
		return () => {
			unsubscribe()
			events.close()
		}
	}, [loadBundle, query.$refetch])

	return null
}
