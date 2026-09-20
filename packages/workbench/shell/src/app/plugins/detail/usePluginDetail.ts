import { useCallback, useMemo } from 'react'
import { usePluginDependencyGraph } from '../pluginDependencyGraph'
import { selectPluginDependencyDetail } from '../pluginDependencyGraphSelectors'
import { type PluginStatusEntry, usePluginOverview } from '../pluginOverview'

const EMPTY_STATUS_ENTRIES: readonly PluginStatusEntry[] = Object.freeze([])

export function usePluginDetail(pluginRoute?: string) {
	const overviewState = usePluginOverview()
	const graphState = usePluginDependencyGraph()
	const statusEntries = overviewState.overview?.status?.statuses ?? EMPTY_STATUS_ENTRIES
	const refetchOverview = overviewState.refetch
	const refetchGraph = graphState.refetch

	const statusMap = useMemo(() => {
		const map = new Map<string, PluginStatusEntry>()
		for (const entry of statusEntries) {
			if (entry?.route) map.set(entry.route, entry)
		}
		return map
	}, [statusEntries])
	const statusEntry = useMemo(() => {
		if (!pluginRoute) return null
		return statusMap.get(pluginRoute) ?? null
	}, [pluginRoute, statusMap])

	const listed = useMemo(() => {
		if (!pluginRoute) return false
		return statusMap.has(pluginRoute)
	}, [pluginRoute, statusMap])

	const owner = statusEntry?.address
	const dependencyDetail = useMemo(
		() =>
			owner && graphState.graph ? selectPluginDependencyDetail(graphState.graph, owner) : null,
		[graphState.graph, owner],
	)
	const detail = statusEntry
		? {
				route: statusEntry.route,
				address: statusEntry.address,
				rootExportName: statusEntry.rootExportName,
				label: statusEntry.label,
				desc: '',
				dependencyDetail,
			}
		: undefined
	const ready = detail !== undefined
	const loading = overviewState.isLoading || graphState.isLoading
	const error =
		!overviewState.hasSnapshot && overviewState.error
			? new Error(overviewState.error)
			: !graphState.hasSnapshot && graphState.error
				? new Error(graphState.error)
				: null

	const refetch = useCallback(async () => {
		await Promise.all([refetchOverview(), refetchGraph()])
	}, [refetchGraph, refetchOverview])

	return {
		detail,
		ready,
		listed,
		hasStatusSnapshot: overviewState.hasSnapshot,
		statusEntry,
		dependencyGraph: {
			detail: dependencyDetail,
			isLoading: graphState.isLoading,
			isStale: graphState.isStale,
			...(graphState.error === undefined ? {} : { error: graphState.error }),
		},
		error,
		loading,
		refetch,
	}
}
