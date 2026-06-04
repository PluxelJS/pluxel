import { type PluginConstructor, type Context as PlxContext } from '@pluxel/core'
import type { InferOutput } from 'valibot'
import type {
	PluginSourceInfo,
	PluginStatusEntryLifecycleStage,
	PluginStatusOverview,
} from './schema'
import { getRuntimePluginCatalog } from '../../../services/runtime/catalog/RuntimePluginCatalogService'

type LifecycleStage = InferOutput<typeof PluginStatusEntryLifecycleStage>
type SourceOutput = InferOutput<typeof PluginSourceInfo>

export function resolvePluginSource(
	pCtx: PlxContext,
	name: string,
	ctor?: PluginConstructor,
): SourceOutput {
	return getRuntimePluginCatalog(pCtx).resolveSource(name, ctor)
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
	return getRuntimePluginCatalog(pCtx).readStatus(name, ctor) as {
		isRunning: boolean
		isEnabled: boolean
		lifecycleStage: LifecycleStage
		source: SourceOutput
	}
}

export function getStatusOverview(pCtx: PlxContext) {
	const overview = getRuntimePluginCatalog(pCtx).statusOverview()
	const entries: Array<InferOutput<typeof PluginStatusOverview>['statuses'][number]> = []
	for (const snap of overview.statuses) {
		entries.push({
			__typename: 'PluginStatusEntry' as const,
			name: snap.name,
			isRunning: snap.isRunning,
			isEnabled: snap.isEnabled,
			lifecycleStage: snap.lifecycleStage as LifecycleStage,
			source: snap.source as SourceOutput,
		})
	}

	return {
		__typename: 'PluginStatusOverview' as const,
		statuses: entries,
		summary: {
			__typename: 'PluginStatusSummary' as const,
			...overview.summary,
		},
	} satisfies InferOutput<typeof PluginStatusOverview>
}
