import type { Context as PlxContext, PluginConstructor } from '@pluxel/core'
import type { InferOutput } from 'valibot'

import {
	PluginSourceInfo,
	PluginStatusEntryLifecycleStage,
	PluginStatusOverview,
} from './schema'

type LifecycleStage = InferOutput<typeof PluginStatusEntryLifecycleStage>
type SourceOutput = InferOutput<typeof PluginSourceInfo>

function findModuleId(pCtx: PlxContext, name: string, ctor?: PluginConstructor) {
	const direct = pCtx.loader.registry.name2PathMap.get(name)
	if (direct) return direct
	if (!ctor) return null
	for (const [moduleId, modules] of pCtx.loader.registry.modules) {
		if (modules.some((item) => item.ctor === ctor)) {
			return moduleId
		}
	}
	return null
}

export function resolvePluginSource(
	pCtx: PlxContext,
	name: string,
	ctor?: PluginConstructor,
): SourceOutput {
	const moduleId = findModuleId(pCtx, name, ctor)
	if (moduleId) {
		const packageSpec = pCtx.packageService?.getPackageSpecByModuleId?.(moduleId)
		if (packageSpec) {
			return {
				__typename: 'PluginSourceInfo' as const,
				kind: 'package',
				packageName: packageSpec.name,
				version: packageSpec.version ?? null,
				tag: packageSpec.tag ?? null,
				moduleId,
			}
		}
		return {
			__typename: 'PluginSourceInfo' as const,
			kind: 'hmr',
			moduleId,
			packageName: null,
			version: null,
			tag: null,
		}
	}
	return {
		__typename: 'PluginSourceInfo' as const,
		kind: 'unknown',
		moduleId: null,
		packageName: null,
		version: null,
		tag: null,
	}
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
	const isRunning = pCtx.loader.isRunning(ctor)
	const isEnabled = pCtx.configService.isEnable(name)
	const lifecycleStage = !isEnabled ? 'disabled' : isRunning ? 'running' : 'stopped'
	const source = resolvePluginSource(pCtx, name, ctor)
	return { isRunning, isEnabled, lifecycleStage, source }
}

export function getStatusOverview(pCtx: PlxContext) {
	const { statuses, summary } = pCtx.loader.getFullPluginStatus()
	const nameToCtor = pCtx.loader.registry.names
	return {
		__typename: 'PluginStatusOverview' as const,
		statuses: Object.keys(statuses).map((name) => ({
			__typename: 'PluginStatusEntry' as const,
			name,
			isRunning: statuses[name].isRunning,
			isEnabled: statuses[name].isEnabled,
			lifecycleStage: statuses[name].lifecycleStage,
			source: resolvePluginSource(pCtx, name, nameToCtor.get(name)),
		})),
		summary: {
			__typename: 'PluginStatusSummary' as const,
			total: summary.total,
			running: summary.running,
			stopped: summary.stopped,
			disabled: summary.disabled,
		},
	} satisfies InferOutput<typeof PluginStatusOverview>
}
