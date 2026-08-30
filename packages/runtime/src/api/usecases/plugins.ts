import { pluginNodeIndexKey, type Context, type PluginNodeAddress } from '@pluxel/core'
import {
	requireRuntimePluginGraphCoordinator,
	type RuntimePluginGraphCommittedView,
} from '../../internal/reconciliation'
import {
	readRuntimeRouteCapabilities,
	type RuntimePluginSource,
	unknownPluginSource,
} from '../../runtime/capabilities'
import type { PluginSourceSnapshot, PluginStatusSnapshot } from '../../web/protocol'
import {
	projectedPluginByAddress,
	projectPluginCatalogFromView,
} from '../features/plugins/catalog-projection'

function plainSource(source: RuntimePluginSource): PluginSourceSnapshot {
	const { __typename: _type, ...rest } = source
	return rest as PluginSourceSnapshot
}

function resolvePluginSource(ctx: Context, address: PluginNodeAddress): RuntimePluginSource {
	return readRuntimeRouteCapabilities(ctx)?.source?.resolveSource(address) ?? unknownPluginSource()
}

export async function pluginStatus(
	ctx: Context,
	address: PluginNodeAddress,
): Promise<PluginStatusSnapshot | null> {
	const projected = await requireRuntimePluginGraphCoordinator(ctx).readCommitted((view) =>
		projectedPluginByAddress(projectCommittedPluginCatalog(ctx, view), address),
	)
	if (!projected) return null
	return portablePluginStatus(projected)
}

export type PluginStatusOverview = Readonly<{
	plugins: readonly PluginStatusSnapshot[]
	summary: Readonly<{ total: number; running: number; stopped: number; autoStart: number }>
}>

export async function pluginStatusOverview(ctx: Context): Promise<PluginStatusOverview> {
	const overview = await requireRuntimePluginGraphCoordinator(ctx).readCommitted((view) =>
		projectCommittedPluginCatalog(ctx, view),
	)
	return {
		plugins: overview.entries.map(portablePluginStatus),
		summary: overview.summary,
	}
}

export function portablePluginStatus(
	entry: import('../features/plugins/catalog-projection').PluginCatalogProjectionEntry,
): PluginStatusSnapshot {
	const { nodeKey: _nodeKey, source, issues, ...snapshot } = entry
	return {
		...snapshot,
		issues: [...issues],
		source: plainSource(source),
	}
}

export function projectCommittedPluginCatalog(ctx: Context, view: RuntimePluginGraphCommittedView) {
	return projectPluginCatalogFromView(ctx.root, {
		catalog: view.catalog,
		state: view.runtimeState.state,
		reconciliation: view.reconciliation,
		sessionIntents: view.sessionIntents,
		desiredControl: view.desiredControl,
		coreNodes: view.coreAdjacency.nodes,
		runningNodeKeys: new Set(view.runningNodes.map(pluginNodeIndexKey)),
		source: readRuntimeRouteCapabilities(ctx)?.source,
	})
}

export function pluginSource(ctx: Context, address: PluginNodeAddress) {
	const source = resolvePluginSource(ctx, address)
	const { __typename: _type, ...rest } = source
	return rest
}
