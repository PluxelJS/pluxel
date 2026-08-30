import type { PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayout, WorkbenchLayoutEntry } from '@pluxel/runtime/workbench/client'
import {
	compileWorkbenchRoute,
	workbenchRoutesOverlap,
	type CompiledWorkbenchRoute,
} from './routes'

export type WorkbenchTargetId = PluginNodeAddress | null
export type WorkbenchTargetState = 'loading' | 'ready' | 'error'

export type RegisteredWorkbenchRoute = Readonly<{
	compiled: CompiledWorkbenchRoute
	entry: WorkbenchLayoutEntry
}>

export type WorkbenchResolvedRoute = Readonly<{
	entry: WorkbenchLayoutEntry
	location: string
	params: Readonly<Record<string, string>>
	frame: 'shell' | 'standalone'
}>

export type WorkbenchTargetSnapshot = Readonly<{
	target: WorkbenchTargetId
	state: WorkbenchTargetState
	layout: WorkbenchLayout | null
	error: Error | null
	tabs: readonly WorkbenchLayoutEntry[]
	navigationRoutes: readonly WorkbenchLayoutEntry[]
	routes: readonly RegisteredWorkbenchRoute[]
}>

export function createInitialWorkbenchSnapshot(target: WorkbenchTargetId): WorkbenchTargetSnapshot {
	return Object.freeze({
		target,
		state: 'loading',
		layout: null,
		error: null,
		tabs: Object.freeze([]),
		navigationRoutes: Object.freeze([]),
		routes: Object.freeze([]),
	})
}

export function compileWorkbenchSnapshot(
	target: WorkbenchTargetId,
	layout: WorkbenchLayout,
): WorkbenchTargetSnapshot {
	const tabs: WorkbenchLayoutEntry[] = []
	const navigationRoutes: WorkbenchLayoutEntry[] = []
	const routes: RegisteredWorkbenchRoute[] = []

	for (const entry of layout.entries) {
		const placement = entry.placement
		if (placement.kind === 'tab') {
			if (target !== null) tabs.push(entry)
			continue
		}
		if (target === null) {
			if (placement.navigation) navigationRoutes.push(entry)
			continue
		}

		const compiled = compileWorkbenchRoute(placement.path)
		const conflict = routes.find(
			(candidate) =>
				candidate.compiled.segments.some((segment) => segment.parameter !== undefined) &&
				compiled.segments.some((segment) => segment.parameter !== undefined) &&
				workbenchRoutesOverlap(candidate.compiled, compiled),
		)
		if (conflict) {
			throw new Error(
				`[workbench-app] ambiguous routes ${conflict.compiled.path} and ${compiled.path}`,
			)
		}
		routes.push(Object.freeze({ compiled, entry }))
	}

	routes.sort(
		(left, right) =>
			right.compiled.staticSegments - left.compiled.staticSegments ||
			left.compiled.path.localeCompare(right.compiled.path),
	)
	return Object.freeze({
		target,
		state: 'ready',
		layout,
		error: null,
		tabs: Object.freeze(tabs),
		navigationRoutes: Object.freeze(navigationRoutes),
		routes: Object.freeze(routes),
	})
}
