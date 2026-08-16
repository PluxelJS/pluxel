import type { Context as PlxContext, PluginNodeAddressSnapshot } from '@pluxel/core'
import type { InferOutput } from 'valibot'
import type {
	PluginSourceInfo,
	PluginStatusEntryLifecycleStage,
	PluginStatusOverview,
} from './schema'
import {
	readRuntimePluginStatus,
	runtimePluginStatusOverview,
	unknownPluginSource,
} from '../../../runtime/capabilities'
import { pluginNodeAddressKey } from '../../../runtime/plugin-address'

type LifecycleStage = InferOutput<typeof PluginStatusEntryLifecycleStage>
type SourceOutput = InferOutput<typeof PluginSourceInfo>

export function resolvePluginSource(
	pCtx: PlxContext,
	address: PluginNodeAddressSnapshot,
): SourceOutput {
	const ctor = pCtx.runtimeRoute?.catalog.resolve(address)
	return (pCtx.runtimeRoute?.source?.resolveSource(address, ctor) ??
		unknownPluginSource()) as SourceOutput
}

export function readStatusSnapshot(pCtx: PlxContext, address: PluginNodeAddressSnapshot) {
	const entry = pCtx.runtimeRoute?.catalog
		.listRegistered()
		.find((candidate) => pluginNodeAddressKey(candidate.address) === pluginNodeAddressKey(address))
	if (!entry) throw new Error('Plugin node is not present in the route catalog')
	return readRuntimePluginStatus(pCtx, entry) as {
		address: PluginNodeAddressSnapshot
		displayName: string
		rootExportName: string
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: LifecycleStage
		source: SourceOutput
	}
}

export function getStatusOverview(pCtx: PlxContext) {
	const overview = runtimePluginStatusOverview(pCtx)
	const plugins: Array<InferOutput<typeof PluginStatusOverview>['plugins'][number]> = []
	const statuses = []
	for (const snapshot of overview.statuses) {
		const id = pluginNodeAddressKey(snapshot.address)
		plugins.push({
			__typename: 'Plugin',
			id,
			name: snapshot.displayName,
			rootExportName: snapshot.rootExportName,
			address: snapshot.address,
		})
		statuses.push({
			__typename: 'PluginStatusEntry' as const,
			id,
			name: snapshot.displayName,
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
