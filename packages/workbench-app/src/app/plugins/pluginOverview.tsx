import { useCallback, useEffect, useRef } from 'react'
import { parsePluginNodeAddress, type PluginNodeAddressSnapshot } from '@pluxel/core'
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
	try {
		const catalog = query.pluginCatalog
		const status = catalog.status
		const statusIds = status.plugins.ids
		const groupIds = catalog.groups.ids
		if (!statusIds || !groupIds) return null

		const statuses = statusIds.map((id) => {
			const plugin = catalog.plugin({ id })
			return {
				id: plugin.id ?? id,
				name: plugin.name ?? id,
				rootExportName: plugin.rootExportName ?? '',
				address: materializeAddress(plugin.address),
				isRunning: Boolean(plugin.status.isRunning),
				isEnabled: plugin.status.isEnabled !== false,
				lifecycleStage: plugin.status.lifecycleStage ?? PluginStatusEntryLifecycleStage.stopped,
				source: {
					kind: plugin.status.source.kind ?? PluginSourceInfoKind.unknown,
					moduleId: plugin.status.source.moduleId ?? null,
					packageName: plugin.status.source.packageName ?? null,
					version: plugin.status.source.version ?? null,
					tag: plugin.status.source.tag ?? null,
				},
			} satisfies PluginStatusEntry
		})
		const groups = groupIds.map((id) => {
			const group = catalog.group({ id })
			const nodes = (group.nodes.ids ?? []).map((nodeId) => {
				const node = catalog.groupNode({ id: nodeId })
				return {
					__typename: 'PluginGroupNode' as const,
					id: node.id ?? nodeId,
					displayName: node.displayName ?? nodeId,
					rootExportName: node.rootExportName ?? '',
					address: materializeAddress(node.address),
				}
			})
			return {
				__typename: 'PluginGroup' as const,
				id: group.id ?? id,
				groupId: group.groupId ?? id,
				name: group.name ?? '',
				nodes,
			} satisfies PluginGroupEntry
		})

		return {
			status: {
				statuses,
				summary: {
					total: Number(status.summary.total ?? 0),
					running: Number(status.summary.running ?? 0),
					stopped: Number(status.summary.stopped ?? 0),
					disabled: Number(status.summary.disabled ?? 0),
				},
			},
			groups,
		}
	} catch {
		return null
	}
}

function materializeAddress(node: {
	definition: {
		entry: { kind?: string; packageName?: string | null; source?: string | null }
		exportName?: string
	}
	instance?: string
	forkId?: string | null
}): PluginNodeAddressSnapshot {
	const entry = node.definition.entry
	return parsePluginNodeAddress({
		definition: {
			entry:
				entry.kind === 'package-root'
					? { kind: 'package-root', packageName: entry.packageName }
					: { kind: entry.kind, source: entry.source },
			exportName: node.definition.exportName,
		},
		instance: node.instance,
		forkId: node.forkId,
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
