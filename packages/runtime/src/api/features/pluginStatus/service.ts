import type { Context as PlxContext, PluginConstructor } from '@pluxel/core'
import type { InferOutput } from 'valibot'
import type {
	PluginSourceInfo,
	PluginStatusEntryLifecycleStage,
	PluginStatusOverview,
} from './schema'
import { runtimePluginCatalog } from '../plugins/catalog'

type LifecycleStage = InferOutput<typeof PluginStatusEntryLifecycleStage>
type SourceOutput = InferOutput<typeof PluginSourceInfo>

export function resolvePluginSource(
	pCtx: PlxContext,
	name: string,
	ctor?: PluginConstructor,
): SourceOutput {
	return runtimePluginCatalog(pCtx).resolveSource(name, ctor)
}

export function readStatusSnapshot(
	pCtx: PlxContext,
	name: string,
	ctor: PluginConstructor,
): {
	isRunning: boolean
	isEnabled: boolean
	lifecycleStage: LifecycleStage
	source: SourceOutput
} {
	return runtimePluginCatalog(pCtx).readStatus(name, ctor) as {
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: LifecycleStage
		source: SourceOutput
	}
}

export function getStatusOverview(pCtx: PlxContext) {
	const overview = runtimePluginCatalog(pCtx).statusOverview()
	const plugins: Array<InferOutput<typeof PluginStatusOverview>['plugins'][number]> = []
	const statuses = []
	for (const snap of overview.statuses) {
		plugins.push({
			__typename: 'Plugin' as const,
			id: snap.name,
			name: snap.name,
		})
		statuses.push({
			__typename: 'PluginStatusEntry' as const,
			id: snap.name,
			name: snap.name,
			isRunning: snap.isRunning,
			isEnabled: snap.isEnabled,
			lifecycleStage: snap.lifecycleStage as LifecycleStage,
			source: snap.source as SourceOutput,
		})
	}

	const output = {
		__typename: 'PluginStatusOverview' as const,
		plugins,
		summary: {
			__typename: 'PluginStatusSummary' as const,
			...overview.summary,
		},
	} satisfies InferOutput<typeof PluginStatusOverview>
	return { ...output, statuses }
}
