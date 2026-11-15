import {
	buildPluginNodeLabels,
	type PluginNodeLabel,
	formatPluginNodeReference,
	formatPluginNodeRoute,
	pluginNodeIndexKey,
	type Context as PlxContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import {
	hostPluginStatusOverviewFromView,
	hostPluginStatusFromView,
	hostPluginCatalogEntriesFromView,
	type HostPluginCatalogEntry,
	type HostPluginStatusOverview,
	type HostPluginStatusProjectionView,
	type HostPluginStatusSnapshot,
	type HostPluginGraphCommittedView,
} from '@pluxel/host/internal'

export { buildPluginNodeLabels, type PluginNodeLabel } from '@pluxel/core'

export type PluginCatalogProjectionEntry = HostPluginStatusSnapshot &
	Readonly<{
		nodeKey: string
		reference: string
		route: string
		label: PluginNodeLabel
	}>

export type PluginCatalogProjection = Readonly<{
	entries: readonly PluginCatalogProjectionEntry[]
	summary: HostPluginStatusOverview['summary']
	byRoute: ReadonlyMap<string, PluginCatalogProjectionEntry>
	byAddress: ReadonlyMap<string, PluginCatalogProjectionEntry>
}>

type PluginCatalogStaticProjection = Readonly<{
	catalog: PluginCatalogProjectionView['catalog']
	state: PluginCatalogProjectionView['state']
	sessionIntents: PluginCatalogProjectionView['sessionIntents']
	desiredControl: PluginCatalogProjectionView['desiredControl']
	appliedNodes: HostPluginGraphCommittedView['applied']['nodes']
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

/** Core returns fresh adjacency arrays; its committed membership is owned by the applied map. */
export type PluginCatalogProjectionView = HostPluginStatusProjectionView &
	Pick<HostPluginGraphCommittedView, 'applied'>

const staticProjectionByRoot = new WeakMap<PlxContext, PluginCatalogStaticProjection>()

/** @internal Projects the catalog from one coordinator-pinned committed view. */
export function projectPluginCatalogFromView(
	root: PlxContext,
	view: PluginCatalogProjectionView,
): PluginCatalogProjection {
	return projectPluginCatalogOverview(root, view, hostPluginStatusOverviewFromView(view))
}

/** One runtime projection; the label inventory contains identity and display names only. */
export function projectPluginStatusFromView(
	root: PlxContext,
	view: PluginCatalogProjectionView,
	address: PluginNodeAddress,
): PluginCatalogProjectionEntry | null {
	const status = hostPluginStatusFromView(view, address)
	if (!status) return null
	const labels = staticPluginCatalogProjection(root, view)
	return { ...status, ...labels.byAddress.get(pluginNodeIndexKey(address))! }
}

function projectPluginCatalogOverview(
	root: PlxContext,
	view: PluginCatalogProjectionView,
	overview: HostPluginStatusOverview,
): PluginCatalogProjection {
	const projected = staticPluginCatalogProjection(root, view, overview.statuses)
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
	view: PluginCatalogProjectionView,
	statuses?: readonly HostPluginCatalogEntry[],
): PluginCatalogStaticProjection {
	const cached = staticProjectionByRoot.get(root)
	if (
		cached &&
		cached.catalog === view.catalog &&
		cached.state === view.state &&
		cached.sessionIntents === view.sessionIntents &&
		cached.desiredControl === view.desiredControl &&
		cached.appliedNodes === view.applied.nodes
	) {
		return cached
	}

	const inventory = statuses ?? hostPluginCatalogEntriesFromView(view)
	const labels = buildPluginNodeLabels(
		inventory.map(({ address, displayName }) => ({ nodeAddress: address, displayName })),
	)
	const byAddress = new Map(
		inventory.map(({ address }) => {
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
	const projection = Object.freeze({
		catalog: view.catalog,
		state: view.state,
		sessionIntents: view.sessionIntents,
		desiredControl: view.desiredControl,
		appliedNodes: view.applied.nodes,
		byAddress,
	})
	staticProjectionByRoot.set(root, projection)
	return projection
}

export function projectedPluginByAddress(
	projection: PluginCatalogProjection,
	address: PluginNodeAddress,
): PluginCatalogProjectionEntry | undefined {
	return projection.byAddress.get(pluginNodeIndexKey(address))
}
