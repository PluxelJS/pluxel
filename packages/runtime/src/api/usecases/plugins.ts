import type { Context, PluginNodeAddress } from '@pluxel/core'
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
	projectPluginCatalog,
} from '../features/plugins/catalog-projection'

function plainSource(source: RuntimePluginSource): PluginSourceSnapshot {
	const { __typename: _type, ...rest } = source
	return rest as PluginSourceSnapshot
}

function resolvePluginSource(ctx: Context, address: PluginNodeAddress): RuntimePluginSource {
	return readRuntimeRouteCapabilities(ctx)?.source?.resolveSource(address) ?? unknownPluginSource()
}

export function pluginStatus(
	ctx: Context,
	address: PluginNodeAddress,
): PluginStatusSnapshot | null {
	const projected = projectedPluginByAddress(projectPluginCatalog(ctx), address)
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

export function pluginsList(ctx: Context): PluginsListOutput {
	const overview = projectPluginCatalog(ctx)
	return {
		plugins: overview.entries.map(({ nodeKey: _nodeKey, source, issues, ...snapshot }) => ({
			...snapshot,
			issues: [...issues],
			source: plainSource(source),
		})),
		summary: overview.summary,
	}
}

export function pluginSource(ctx: Context, address: PluginNodeAddress) {
	const source = resolvePluginSource(ctx, address)
	const { __typename: _type, ...rest } = source
	return rest
}
