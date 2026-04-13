import {
	formatForkPluginId,
	getPluginInfo,
	type PluginConstructor,
	type Context as PlxContext,
} from '@pluxel/core'
import type { InferOutput } from 'valibot'
import { EXTRA_FORKS, type ForksExtra } from '../../../services/runtime/loader/selection'
import type {
	PluginSourceInfo,
	PluginStatusEntryLifecycleStage,
	PluginStatusOverview,
} from './schema'

type LifecycleStage = InferOutput<typeof PluginStatusEntryLifecycleStage>
type SourceOutput = InferOutput<typeof PluginSourceInfo>

function findModuleId(pCtx: PlxContext, name: string, ctor?: PluginConstructor) {
	return pCtx.loader.api.registry.findModuleId(name, ctor)
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
	const isRunning = pCtx.loader.api.runtime.isRunning(ctor)
	const isEnabled = pCtx.configService.isEnabledInConfig(name)
	const lifecycleStage = !isEnabled ? 'disabled' : isRunning ? 'running' : 'stopped'
	const source = resolvePluginSource(pCtx, name, ctor)
	return { isRunning, isEnabled, lifecycleStage, source }
}

export function getStatusOverview(pCtx: PlxContext) {
	const nameToCtor = pCtx.loader.api.registry.listRegistered()

	// Include fork plugins:
	// - persisted forks from the fork catalog (so they can be toggled in UI);
	// - runtime forks already created from loaded bases (even if not yet persisted).
	const forkNames = new Set<string>()
	const catalog = pCtx.configService.getExtra<ForksExtra>(EXTRA_FORKS) ?? {}
	for (const [baseName, baseCtor] of nameToCtor) {
		const forkIds = catalog?.[baseName]
		if (Array.isArray(forkIds)) {
			for (const raw of forkIds) {
				const fid = typeof raw === 'string' ? raw.trim() : ''
				if (!fid) continue
				try {
					forkNames.add(formatForkPluginId(baseName, fid))
				} catch {}
			}
		}
		for (const forkCtor of pCtx.registry.listForks(baseCtor as any)) {
			try {
				forkNames.add(getPluginInfo(forkCtor as any).id)
			} catch {}
		}
	}

	const allNames = [...new Set<string>([...nameToCtor.keys(), ...forkNames])].sort((a, b) =>
		a.localeCompare(b),
	)
	const entries: Array<InferOutput<typeof PluginStatusOverview>['statuses'][number]> = []
	for (const name of allNames) {
		const ctor = pCtx.loader.api.runtime.resolve(name) ?? nameToCtor.get(name)
		if (!ctor) continue
		const snap = readStatusSnapshot(pCtx, name, ctor)
		entries.push({
			__typename: 'PluginStatusEntry' as const,
			name,
			isRunning: snap.isRunning,
			isEnabled: snap.isEnabled,
			lifecycleStage: snap.lifecycleStage,
			source: snap.source,
		})
	}

	let running = 0
	let disabled = 0
	for (const e of entries) {
		if (e.isRunning) running += 1
		if (e.isEnabled === false) disabled += 1
	}

	return {
		__typename: 'PluginStatusOverview' as const,
		statuses: entries,
		summary: {
			__typename: 'PluginStatusSummary' as const,
			total: entries.length,
			running,
			stopped: entries.length - running - disabled,
			disabled,
		},
	} satisfies InferOutput<typeof PluginStatusOverview>
}
