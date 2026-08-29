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
import type {
	PluginSourceSnapshot,
	PluginStatusSnapshot,
	PluginsListOutput,
} from '../../web/protocol'
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
		projectedPluginByAddress(projectCommittedCatalog(ctx, view), address),
	)
	if (!projected) return null
	const { nodeKey: _nodeKey, issues, reference, route, label, source, ...snapshot } = projected
	return {
		...snapshot,
		issues: [...issues],
		reference,
		route,
		label,
		source: plainSource(source),
	}
}

export async function pluginsList(ctx: Context): Promise<PluginsListOutput> {
	const overview = await requireRuntimePluginGraphCoordinator(ctx).readCommitted((view) =>
		projectCommittedCatalog(ctx, view),
	)
	return {
		plugins: overview.entries.map(({ nodeKey: _nodeKey, source, issues, ...snapshot }) => ({
			...snapshot,
			issues: [...issues],
			source: plainSource(source),
		})),
		summary: overview.summary,
	}
}

function projectCommittedCatalog(ctx: Context, view: RuntimePluginGraphCommittedView) {
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
