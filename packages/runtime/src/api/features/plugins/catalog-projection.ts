import {
	formatPluginNodeReference,
	formatPluginNodeRoute,
	pluginNodeIndexKey,
	type Context as PlxContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	runtimePluginStatusOverview,
	type RuntimePluginStatusOverview,
	type RuntimePluginStatusSnapshot,
} from '../../../runtime/capabilities'
import { buildPluginNodeLabels, type PluginNodeLabel } from '../../../runtime/plugin-label'

export { buildPluginNodeLabels, type PluginNodeLabel } from '../../../runtime/plugin-label'

export type PluginCatalogProjectionEntry = RuntimePluginStatusSnapshot &
	Readonly<{
		nodeKey: string
		reference: string
		route: string
		label: PluginNodeLabel
	}>

export type PluginCatalogProjection = Readonly<{
	entries: readonly PluginCatalogProjectionEntry[]
	summary: RuntimePluginStatusOverview['summary']
	byRoute: ReadonlyMap<string, PluginCatalogProjectionEntry>
	byAddress: ReadonlyMap<string, PluginCatalogProjectionEntry>
}>

type PluginCatalogStaticProjection = Readonly<{
	shape: readonly Readonly<{ nodeKey: string; displayName: string }>[]
	byAddress: ReadonlyMap<
		string,
		Readonly<{
			nodeKey: string
			reference: string
			route: string
			label: PluginNodeLabel
		}>
	>
}>

const staticProjectionByRoot = new WeakMap<PlxContext, PluginCatalogStaticProjection>()

export function projectPluginCatalog(pCtx: PlxContext): PluginCatalogProjection {
	const overview = runtimePluginStatusOverview(pCtx)
	const projected = staticPluginCatalogProjection(pCtx.root, overview.statuses)
	const entries = overview.statuses.map((entry) => ({
		...entry,
		...projected.byAddress.get(pluginNodeIndexKey(entry.address))!,
	}))
	return {
		entries,
		summary: overview.summary,
		byRoute: new Map(entries.map((entry) => [entry.route, entry])),
		byAddress: new Map(entries.map((entry) => [entry.nodeKey, entry])),
	}
}

function staticPluginCatalogProjection(
	root: PlxContext,
	statuses: readonly RuntimePluginStatusSnapshot[],
): PluginCatalogStaticProjection {
	const shape = statuses.map(({ address, displayName }) => ({
		nodeKey: pluginNodeIndexKey(address),
		displayName,
	}))
	const cached = staticProjectionByRoot.get(root)
	if (
		cached &&
		cached.shape.length === shape.length &&
		cached.shape.every(
			(entry, index) =>
				entry.nodeKey === shape[index]!.nodeKey && entry.displayName === shape[index]!.displayName,
		)
	) {
		return cached
	}

	const labels = buildPluginNodeLabels(
		statuses.map(({ address, displayName }) => ({ nodeAddress: address, displayName })),
	)
	const byAddress = new Map(
		statuses.map(({ address }) => {
			const nodeKey = pluginNodeIndexKey(address)
			return [
				nodeKey,
				Object.freeze({
					nodeKey,
					reference: formatPluginNodeReference(address),
					route: formatPluginNodeRoute(address),
					label: labels.get(nodeKey)!,
				}),
			] as const
		}),
	)
	const projection = Object.freeze({ shape: Object.freeze(shape), byAddress })
	staticProjectionByRoot.set(root, projection)
	return projection
}

export function projectedPluginByAddress(
	projection: PluginCatalogProjection,
	address: PluginNodeAddress,
): PluginCatalogProjectionEntry | undefined {
	return projection.byAddress.get(pluginNodeIndexKey(address))
}
