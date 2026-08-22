import type { Context, PluginNodeAddress } from '@pluxel/core'
import { resolvePluginSource } from '../features/pluginStatus/service'
import {
	type RuntimePluginSource,
	type RuntimePluginStatusIssue,
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

export type PluginStatusSnapshot = Omit<RuntimePluginStatusSnapshot, 'source' | 'issues'> & {
	reference: string
	route: string
	label: PluginNodeLabel
	issues: RuntimePluginStatusIssue[]
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
