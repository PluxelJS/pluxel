import {
	getPluginInfo,
	pluginDefinitionAddressEqual,
	pluginNodeIndexKey,
	type Context as PlxContext,
	type PluginNodeAddress,
} from '@pluxel/core'
import type { InferOutput } from 'valibot'
import type {
	PluginSourceInfo,
	PluginStatusEntryLifecycleStage,
	PluginStatusOverview,
} from './schema'
import { readRuntimePluginStatus, unknownPluginSource } from '../../../runtime/capabilities'
import { projectPluginCatalog } from '../plugins/catalog-projection'

type LifecycleStage = InferOutput<typeof PluginStatusEntryLifecycleStage>
type SourceOutput = InferOutput<typeof PluginSourceInfo>

export function resolvePluginSource(pCtx: PlxContext, address: PluginNodeAddress): SourceOutput {
	const ctor = pCtx.runtimeRoute?.catalog.resolve(address)
	return (pCtx.runtimeRoute?.source?.resolveSource(address, ctor) ??
		unknownPluginSource()) as SourceOutput
}

export function readStatusSnapshot(pCtx: PlxContext, address: PluginNodeAddress) {
	const catalog = pCtx.runtimeRoute?.catalog
	const registered = catalog?.listRegistered() ?? []
	let entry = registered.find(
		(candidate) => pluginNodeIndexKey(candidate.address) === pluginNodeIndexKey(address),
	)
	if (!entry && address.variant === 'fork') {
		const ctor = catalog?.resolve(address)
		const base = registered.find((candidate) =>
			pluginDefinitionAddressEqual(candidate.address.definition, address.definition),
		)
		if (ctor && base) {
			entry = {
				address,
				ctor,
				displayName: getPluginInfo(ctor).displayName,
				rootExportName: base.rootExportName,
			}
		}
	}
	if (!entry) throw new Error('Plugin node is not present in the route catalog')
	return readRuntimePluginStatus(pCtx, entry) as {
		address: PluginNodeAddress
		displayName: string
		rootExportName: string
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: LifecycleStage
		source: SourceOutput
	}
}

export function getStatusOverview(pCtx: PlxContext) {
	const overview = projectPluginCatalog(pCtx)
	const plugins: Array<InferOutput<typeof PluginStatusOverview>['plugins'][number]> = []
	const statuses = []
	for (const snapshot of overview.entries) {
		const id = snapshot.route
		plugins.push({
			__typename: 'Plugin',
			id,
			reference: snapshot.reference,
			route: snapshot.route,
			displayName: snapshot.displayName,
			label: snapshot.label.text,
			rootExportName: snapshot.rootExportName,
			address: snapshot.address,
		})
		statuses.push({
			__typename: 'PluginStatusEntry' as const,
			id,
			reference: snapshot.reference,
			route: snapshot.route,
			displayName: snapshot.displayName,
			label: snapshot.label.text,
			address: snapshot.address,
			isRunning: snapshot.isRunning,
			isEnabled: snapshot.isEnabled,
			lifecycleStage: snapshot.lifecycleStage,
			source: snapshot.source,
		})
	}
	const output = {
		__typename: 'PluginStatusOverview' as const,
		plugins,
		summary: { __typename: 'PluginStatusSummary' as const, ...overview.summary },
	} satisfies InferOutput<typeof PluginStatusOverview>
	return { ...output, statuses }
}
