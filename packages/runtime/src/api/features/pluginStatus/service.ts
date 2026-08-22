import {
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
import {
	readRuntimeRouteCapabilities,
	runtimePluginStatusOverview,
	type RuntimePluginStatusSnapshot,
	unknownPluginSource,
} from '../../../runtime/capabilities'
import { projectPluginCatalog } from '../plugins/catalog-projection'

type LifecycleStage = InferOutput<typeof PluginStatusEntryLifecycleStage>
type SourceOutput = InferOutput<typeof PluginSourceInfo>

export function resolvePluginSource(pCtx: PlxContext, address: PluginNodeAddress): SourceOutput {
	return (readRuntimeRouteCapabilities(pCtx)?.source?.resolveSource(address) ??
		unknownPluginSource()) as SourceOutput
}

export function readStatusSnapshot(pCtx: PlxContext, address: PluginNodeAddress) {
	const entry = runtimePluginStatusOverview(pCtx).statuses.find(
		(candidate) => pluginNodeIndexKey(candidate.address) === pluginNodeIndexKey(address),
	)
	if (!entry) throw new Error('Plugin node is not present in the route catalog')
	return entry as RuntimePluginStatusSnapshot & {
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
			availability: snapshot.availability,
			issues: snapshot.issues,
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
