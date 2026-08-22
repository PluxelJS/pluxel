import type {
	WorkbenchLayout,
	WorkbenchLayoutItem,
	WorkbenchPlacement,
} from '@pluxel/runtime/workbench'
import { pluginNodeIndexKey, type PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchModuleRecord } from './client-module-store'
import {
	compileWorkbenchRoute,
	workbenchRoutesOverlap,
	type CompiledWorkbenchRoute,
} from './routes'

export type WorkbenchTargetId = PluginNodeAddress | null
export type WorkbenchTargetState = 'loading' | 'ready' | 'error'

export type RegisteredWorkbenchRoute = Readonly<{
	compiled: CompiledWorkbenchRoute
	frame: 'shell' | 'standalone'
	item: WorkbenchLayoutItem
}>

export type WorkbenchResolvedRoute = Readonly<{
	item: WorkbenchLayoutItem
	params: Readonly<Record<string, string>>
	frame: 'shell' | 'standalone'
}>

export type WorkbenchTargetSnapshot = Readonly<{
	target: WorkbenchTargetId
	state: WorkbenchTargetState
	revision: number
	layout: WorkbenchLayout | null
	error: Error | null
	surfaces: ReadonlyMap<WorkbenchPlacement, readonly WorkbenchLayoutItem[]>
	navigationRoutes: readonly WorkbenchLayoutItem[]
	routes: readonly RegisteredWorkbenchRoute[]
	modules: ReadonlyMap<string, WorkbenchModuleRecord>
}>

const EMPTY_SURFACES = new Map<WorkbenchPlacement, readonly WorkbenchLayoutItem[]>()
const EMPTY_MODULES = new Map<string, WorkbenchModuleRecord>()

export function createInitialWorkbenchSnapshot(target: WorkbenchTargetId): WorkbenchTargetSnapshot {
	return Object.freeze({
		target,
		state: 'loading',
		revision: 0,
		layout: null,
		error: null,
		surfaces: EMPTY_SURFACES,
		navigationRoutes: Object.freeze([]),
		routes: Object.freeze([]),
		modules: EMPTY_MODULES,
	})
}

export function compileWorkbenchSnapshot(
	target: WorkbenchTargetId,
	layout: WorkbenchLayout,
	modules: ReadonlyMap<string, WorkbenchModuleRecord>,
): WorkbenchTargetSnapshot {
	const surfaces = new Map<WorkbenchPlacement, WorkbenchLayoutItem[]>()
	const navigationRoutes: WorkbenchLayoutItem[] = []
	const routes: RegisteredWorkbenchRoute[] = []
	for (const item of layout.items) {
		if (target !== null && item.view.kind === 'remote') validateRemoteView(item, modules)
		if (item.placement === 'plugin.routes') {
			if (target === null) {
				if (item.meta?.route?.addToNav) navigationRoutes.push(item)
				continue
			}
			if (!item.meta?.route || item.view.kind !== 'remote') continue
			const compiled = compileWorkbenchRoute(item.meta.route.path)
			const conflict = routes.find(
				(candidate) =>
					candidate.compiled.segments.some((segment) => segment.parameter !== undefined) &&
					compiled.segments.some((segment) => segment.parameter !== undefined) &&
					workbenchRoutesOverlap(candidate.compiled, compiled),
			)
			if (conflict) {
				throw new Error(
					`[workbench-ui] ambiguous route patterns: ${conflict.compiled.path} and ${compiled.path}`,
				)
			}
			routes.push({ compiled, frame: item.meta.route.frame ?? 'shell', item })
			continue
		}
		let bucket = surfaces.get(item.placement)
		if (!bucket) {
			bucket = []
			surfaces.set(item.placement, bucket)
		}
		bucket.push(item)
	}
	routes.sort((left, right) => right.compiled.staticSegments - left.compiled.staticSegments)
	return Object.freeze({
		target,
		state: 'ready',
		revision: layout.revision,
		layout,
		error: null,
		surfaces,
		navigationRoutes: Object.freeze(navigationRoutes),
		routes: Object.freeze(routes),
		modules: new Map(modules),
	})
}

function validateRemoteView(
	item: WorkbenchLayoutItem,
	modules: ReadonlyMap<string, WorkbenchModuleRecord>,
): void {
	const ownerKey = pluginNodeIndexKey(item.owner.address)
	const record = modules.get(ownerKey)
	if (!record) throw new Error(`[workbench-ui] UI module not found for ${item.owner.displayName}`)
	if (record.module.contractFingerprint !== item.contractFingerprint) {
		throw new Error(`[workbench-ui] Contract mismatch for ${item.owner.displayName}`)
	}
	if (
		typeof record.module.views[item.view.kind === 'remote' ? item.view.export : ''] !== 'function'
	) {
		throw new TypeError(
			`[workbench-ui] View export not found: ${item.owner.displayName}:${
				item.view.kind === 'remote' ? item.view.export : item.viewId
			}`,
		)
	}
}
