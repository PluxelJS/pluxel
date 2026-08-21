import type { Context as PlxContext, PluginNodeAddressSnapshot } from '@pluxel/core'
import {
	runtimePluginStatusOverview,
	type RuntimePluginStatusOverview,
	type RuntimePluginStatusSnapshot,
} from '../../../runtime/capabilities'
import { pluginNodeAddressKey, pluginNodePhysicalKey } from '../../../runtime/plugin-address'

export type PluginCatalogProjectionEntry = RuntimePluginStatusSnapshot & { readonly id: string }

export type PluginCatalogProjection = Readonly<{
	entries: readonly PluginCatalogProjectionEntry[]
	summary: RuntimePluginStatusOverview['summary']
	byId: ReadonlyMap<string, PluginCatalogProjectionEntry>
	byAddress: ReadonlyMap<string, PluginCatalogProjectionEntry>
}>

export function projectPluginCatalog(pCtx: PlxContext): PluginCatalogProjection {
	const overview = runtimePluginStatusOverview(pCtx)
	const ids = assignPluginPublicIds(overview.statuses)
	const entries = overview.statuses.map((entry) => ({
		...entry,
		id: ids.get(pluginNodeAddressKey(entry.address))!,
	}))
	return {
		entries,
		summary: overview.summary,
		byId: new Map(entries.map((entry) => [entry.id, entry])),
		byAddress: new Map(entries.map((entry) => [pluginNodeAddressKey(entry.address), entry])),
	}
}

export function assignPluginPublicIds(
	entries: readonly Pick<RuntimePluginStatusSnapshot, 'address' | 'rootExportName'>[],
): ReadonlyMap<string, string> {
	const candidates = entries.map((entry) => ({
		address: entry.address,
		candidate:
			entry.address.instance === 'default'
				? entry.rootExportName
				: `${entry.rootExportName}~${pluginNodePhysicalKey(entry.address, 12)}`,
	}))
	const counts = new Map<string, number>()
	for (const { candidate } of candidates) counts.set(candidate, (counts.get(candidate) ?? 0) + 1)

	return new Map(
		candidates.map(({ address, candidate }) => [
			pluginNodeAddressKey(address),
			counts.get(candidate) === 1
				? candidate
				: `${candidate}~${pluginNodePhysicalKey(address, 12)}`,
		]),
	)
}

export function projectedPluginByAddress(
	projection: PluginCatalogProjection,
	address: PluginNodeAddressSnapshot,
): PluginCatalogProjectionEntry | undefined {
	return projection.byAddress.get(pluginNodeAddressKey(address))
}
