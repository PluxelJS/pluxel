import { useCallback, useEffect, useRef } from 'react'
import { parsePluginNodeAddress, type PluginNodeAddress } from '@pluxel/core'
import {
	PluginSourceInfoKind,
	PluginStatusEntryLifecycleStage,
	useQuery,
	type PluginGroupEntry,
	type PluginStatusEntry,
	type PluginStatusOverview,
} from '../gqlens'

const PLUGIN_OVERVIEW_QUERY_SCOPE = 'plugin-overview'
const PLUGIN_OVERVIEW_TTL = 30_000

type PluginStatusOverviewView = Omit<PluginStatusOverview, 'plugins'> & {
	statuses: PluginStatusEntry[]
}

export type PluginOverview = {
	status: PluginStatusOverviewView
	groups: PluginGroupEntry[]
}

export type PluginOverviewSnapshot = Readonly<{
	hasSnapshot: boolean
	overview: PluginOverview | null
	isLoading: boolean
	error?: string
	refetch: () => void
}>

function usePluginOverviewQuery() {
	return useQuery({
		policy: 'cache-first',
		ttl: PLUGIN_OVERVIEW_TTL,
		scope: PLUGIN_OVERVIEW_QUERY_SCOPE,
	})
}

function materializePluginOverview(
	query: ReturnType<typeof usePluginOverviewQuery>,
): PluginOverview | null {
	const catalog = query.pluginCatalog
	const status = catalog.status
	const statusIds = status.plugins.ids
	const groupIds = catalog.groups.ids
	if (!statusIds || !groupIds) return null
	const summaryTotal = status.summary.total
	const summaryRunning = status.summary.running
	const summaryStopped = status.summary.stopped
	const summaryDisabled = status.summary.disabled

	const statuses = statusIds.map((id) => {
		const plugin = catalog.plugin({ id })
		const address = materializeAddress(plugin.address)
		const pluginId = plugin.id
		const reference = plugin.reference
		const route = plugin.route
		const displayName = plugin.displayName
		const label = plugin.label
		const rootExportName = plugin.rootExportName
		const isRunning = plugin.status.isRunning
		const isEnabled = plugin.status.isEnabled
		const lifecycleStage = plugin.status.lifecycleStage
		const sourceKind = plugin.status.source.kind
		const sourceModuleId = plugin.status.source.moduleId
		const sourcePackageName = plugin.status.source.packageName
		const sourceVersion = plugin.status.source.version
		const sourceTag = plugin.status.source.tag
		return address && route
			? ({
					id: pluginId ?? route,
					reference: reference ?? '',
					route,
					displayName: displayName ?? label ?? route,
					label: label ?? displayName ?? route,
					rootExportName: rootExportName ?? '',
					address,
					isRunning: Boolean(isRunning),
					isEnabled: isEnabled !== false,
					lifecycleStage: lifecycleStage ?? PluginStatusEntryLifecycleStage.stopped,
					source: {
						kind: sourceKind ?? PluginSourceInfoKind.unknown,
						moduleId: sourceModuleId ?? null,
						packageName: sourcePackageName ?? null,
						version: sourceVersion ?? null,
						tag: sourceTag ?? null,
					},
				} satisfies PluginStatusEntry)
			: null
	})
	const groups = groupIds.map((id) => {
		const group = catalog.group({ id })
		const nodes = (group.nodes.ids ?? []).map((nodeId) => {
			const node = catalog.groupNode({ id: nodeId })
			const address = materializeAddress(node.address)
			const resolvedNodeId = node.id
			const reference = node.reference
			const route = node.route
			const displayName = node.displayName
			const label = node.label
			const rootExportName = node.rootExportName
			return address && route
				? {
						__typename: 'PluginGroupNode' as const,
						id: resolvedNodeId ?? route,
						reference: reference ?? '',
						route,
						displayName: displayName ?? label ?? route,
						label: label ?? displayName ?? route,
						rootExportName: rootExportName ?? '',
						address,
					}
				: null
		})
		return nodes.every((node) => node !== null)
			? ({
					__typename: 'PluginGroup' as const,
					id: group.id ?? id,
					groupId: group.groupId ?? id,
					name: group.name ?? '',
					nodes,
				} satisfies PluginGroupEntry)
			: null
	})

	if (statuses.some((entry) => entry === null) || groups.some((group) => group === null)) {
		return null
	}

	return {
		status: {
			statuses,
			summary: {
				total: Number(summaryTotal ?? 0),
				running: Number(summaryRunning ?? 0),
				stopped: Number(summaryStopped ?? 0),
				disabled: Number(summaryDisabled ?? 0),
			},
		},
		groups,
	}
}

export function materializeAddress(node: {
	definition: {
		entry: {
			kind?: string
			packageName?: string | null
			sourceSpace?: string | null
			path?: string | null
		}
		exportName?: string
	}
	variant?: string
	forkId?: string | null
}): PluginNodeAddress | null {
	// Read both entry variants up front. GQLens records property access as field demand,
	// so branching before these reads would fetch one address field per render cycle.
	const kind = node.definition.entry.kind
	const packageName = node.definition.entry.packageName
	const sourceSpace = node.definition.entry.sourceSpace
	const path = node.definition.entry.path
	const exportName = node.definition.exportName
	const variant = node.variant
	const forkId = node.forkId
	if (
		kind === undefined ||
		exportName === undefined ||
		variant === undefined ||
		(kind === 'package-root'
			? packageName === undefined
			: sourceSpace === undefined || path === undefined) ||
		(variant === 'fork' && forkId === undefined)
	) {
		return null
	}

	const definition = {
		entry:
			kind === 'package-root'
				? { kind: 'package-root' as const, packageName }
				: { kind, sourceSpace, path },
		exportName,
	}
	return parsePluginNodeAddress({
		definition,
		...(variant === 'fork' ? { variant, forkId } : { variant }),
	})
}

/**
 * Reads the shared GQLens overview session directly. The ref only preserves the last
 * renderable projection while a refetch is in flight; GQLens remains the sole cache.
 */
export function usePluginOverview(): PluginOverviewSnapshot {
	const query = usePluginOverviewQuery()
	const lastSnapshotRef = useRef<PluginOverview | null>(null)
	const refetchRef = useRef(query.refetch)
	refetchRef.current = query.refetch

	const current = materializePluginOverview(query)
	const overview = current ?? lastSnapshotRef.current
	useEffect(() => {
		if (current && !query.error) lastSnapshotRef.current = current
	}, [current, query.error])

	const refetch = useCallback(() => {
		refetchRef.current()
	}, [])

	return {
		hasSnapshot: overview !== null,
		overview,
		isLoading: query.loading,
		error: overview ? undefined : query.error?.message,
		refetch,
	}
}
