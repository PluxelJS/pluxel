import { pluginNodeIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import {
	requirePluginHostCoordinator,
	readHostPluginLifecycleIssues,
	type HostOperationOptions,
	type HostPluginGraphCommittedView,
} from '@pluxel/host/internal'
import { readManagementHostOptions } from '../../host-options'
import type { PluginStatusSnapshot } from '../../web/protocol'
import {
	projectedPluginByAddress,
	projectPluginCatalogFromView,
} from '../features/plugins/catalog-projection'

export async function pluginStatus(
	ctx: Context,
	address: PluginNodeAddress,
	options?: HostOperationOptions,
): Promise<PluginStatusSnapshot | null> {
	const projected = await requirePluginHostCoordinator(ctx).readCommitted(
		(view) => projectedPluginByAddress(projectCommittedPluginCatalog(ctx, view), address),
		options,
	)
	if (!projected) return null
	return portablePluginStatus(projected)
}

export type PluginStatusOverview = Readonly<{
	plugins: readonly PluginStatusSnapshot[]
	summary: Readonly<{ total: number; running: number; stopped: number; autoStart: number }>
}>

export async function pluginStatusOverview(
	ctx: Context,
	options?: HostOperationOptions,
): Promise<PluginStatusOverview> {
	const overview = await requirePluginHostCoordinator(ctx).readCommitted(
		(view) => projectCommittedPluginCatalog(ctx, view),
		options,
	)
	return {
		plugins: overview.entries.map(portablePluginStatus),
		summary: overview.summary,
	}
}

export function portablePluginStatus(
	entry: import('../features/plugins/catalog-projection').PluginCatalogProjectionEntry,
): PluginStatusSnapshot {
	const { nodeKey: _nodeKey, issues, ...snapshot } = entry
	return {
		...snapshot,
		issues: [...issues],
	}
}

export function projectCommittedPluginCatalog(ctx: Context, view: HostPluginGraphCommittedView) {
	return projectPluginCatalogFromView(ctx.root, {
		catalog: view.catalog,
		state: view.runtimeState.state,
		reconciliation: view.reconciliation,
		lifecycleIssues: readHostPluginLifecycleIssues(ctx),
		sessionIntents: view.sessionIntents,
		desiredControl: view.desiredControl,
		coreNodes: view.coreAdjacency.nodes,
		runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
		recentUpdate: readManagementHostOptions(ctx)?.recentUpdate,
	})
}
