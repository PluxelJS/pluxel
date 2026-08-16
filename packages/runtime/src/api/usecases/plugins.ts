import type { Context, PluginNodeAddressSnapshot } from '@pluxel/core'
import { readStatusSnapshot, resolvePluginSource } from '../features/pluginStatus/service'
import {
	requireRouteCapability,
	runtimePluginStatusOverview,
	type RuntimePluginSource,
	type RuntimePluginStatusSnapshot,
} from '../../runtime/capabilities'
import { pluginNodeAddressKey } from '../../runtime/plugin-address'

type PluginSourceSnapshot = RuntimePluginSource extends infer Source
	? Source extends RuntimePluginSource
		? Omit<Source, '__typename'>
		: never
	: never

export type PluginStatusSnapshot = Omit<RuntimePluginStatusSnapshot, 'source'> & {
	id: string
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
	address: PluginNodeAddressSnapshot,
): PluginStatusSnapshot | null {
	if (!requireRouteCapability(ctx, 'catalog').resolve(address)) return null
	const snapshot = readStatusSnapshot(ctx, address)
	return {
		...snapshot,
		id: pluginNodeAddressKey(address),
		source: plainSource(snapshot.source as RuntimePluginSource),
	}
}

export function pluginsList(ctx: Context): PluginsListOutput {
	const overview = runtimePluginStatusOverview(ctx)
	return {
		plugins: overview.statuses.map((snapshot) => ({
			...snapshot,
			id: pluginNodeAddressKey(snapshot.address),
			source: plainSource(snapshot.source),
		})),
		summary: overview.summary,
	}
}

export function pluginSource(ctx: Context, address: PluginNodeAddressSnapshot) {
	const source = resolvePluginSource(ctx, address)
	const { __typename: _type, ...rest } = source
	return rest
}
