import type { Context, PluginNodeAddress } from '@pluxel/core'
import { readStatusSnapshot, resolvePluginSource } from '../features/pluginStatus/service'
import {
	requireRouteCapability,
	type RuntimePluginSource,
	type RuntimePluginStatusSnapshot,
} from '../../runtime/capabilities'
import {
	projectedPluginByAddress,
	projectPluginCatalog,
	type PluginNodeLabel,
} from '../features/plugins/catalog-projection'

type PluginSourceSnapshot = RuntimePluginSource extends infer Source
	? Source extends RuntimePluginSource
		? Omit<Source, '__typename'>
		: never
	: never

export type PluginStatusSnapshot = Omit<RuntimePluginStatusSnapshot, 'source'> & {
	reference: string
	route: string
	label: PluginNodeLabel
	source: PluginSourceSnapshot
}

export type PluginsListOutput = {
	plugins: PluginStatusSnapshot[]
	summary: { total: number; running: number; stopped: number; disabled: number }
}

function plainSource(source: RuntimePluginSource): PluginSourceSnapshot {
	const { __typename: _type, ...rest } = source
	return rest as PluginSourceSnapshot
}

export function pluginStatus(
	ctx: Context,
	address: PluginNodeAddress,
): PluginStatusSnapshot | null {
	if (!requireRouteCapability(ctx, 'catalog').resolve(address)) return null
	const snapshot = readStatusSnapshot(ctx, address)
	const projected = projectedPluginByAddress(projectPluginCatalog(ctx), address)
	if (!projected) {
		throw new Error('Plugin node is missing from the catalog projection')
	}
	return {
		...snapshot,
		reference: projected.reference,
		route: projected.route,
		label: projected.label,
		source: plainSource(snapshot.source as RuntimePluginSource),
	}
}

export function pluginsList(ctx: Context): PluginsListOutput {
	const overview = projectPluginCatalog(ctx)
	return {
		plugins: overview.entries.map(({ nodeKey: _nodeKey, source, ...snapshot }) => ({
			...snapshot,
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
