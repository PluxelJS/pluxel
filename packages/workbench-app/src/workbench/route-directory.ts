import { pluginNodeAddressEqual, type PluginNodeAddress } from '@pluxel/core'
import type { WorkbenchLayoutEntry } from '@pluxel/runtime/workbench/client'
import { buildWorkbenchHref, normalizeWorkbenchPath, type WorkbenchFrame } from './paths'
import {
	compileWorkbenchRoute,
	matchWorkbenchRoute,
	workbenchRoutesOverlap,
	type CompiledWorkbenchRoute,
} from './routes'

export type WorkbenchDirectoryRoute = Readonly<{
	entry: WorkbenchLayoutEntry
	compiled: CompiledWorkbenchRoute
	href: string
	canonicalHref: string
	conflict: Readonly<{
		reason: 'reserved' | 'overlap'
		paths: readonly string[]
		targets: readonly PluginNodeAddress[]
	}> | null
}>

export type WorkbenchRouteDirectory = Readonly<{
	routes: readonly WorkbenchDirectoryRoute[]
	conflicts: readonly WorkbenchDirectoryRoute[]
}>

// These roots belong to the Shell, including descendants and canonical Plugin URLs.
const reservedRoots = new Set([
	'plugins',
	'plugin-graph',
	'security',
	'logs',
	'workbench',
	'workbench-standalone',
])

/** Recomputed from the complete committed global layout; registration order never owns a URL. */
export function createWorkbenchRouteDirectory(
	entries: readonly WorkbenchLayoutEntry[],
): WorkbenchRouteDirectory {
	const candidates = entries
		.flatMap((entry) => {
			if (entry.placement.kind !== 'route') return []
			return [
				{
					entry,
					compiled: compileWorkbenchRoute(entry.placement.path),
					canonicalHref: buildWorkbenchHref(
						entry.target.node,
						entry.placement.path,
						entry.placement.frame,
					),
				},
			]
		})
		.sort(
			(left, right) =>
				right.compiled.staticSegments - left.compiled.staticSegments ||
				left.canonicalHref.localeCompare(right.canonicalHref),
		)
	const routes = candidates.map((candidate): WorkbenchDirectoryRoute => {
		const overlapping = candidates.filter(
			(other) =>
				!pluginNodeAddressEqual(candidate.entry.target.node, other.entry.target.node) &&
				workbenchRoutesOverlap(candidate.compiled, other.compiled),
		)
		const first = candidate.compiled.segments[0]
		const reserved = !first || first.parameter !== undefined || reservedRoots.has(first.literal!)
		const conflict =
			reserved || overlapping.length > 0
				? Object.freeze({
						reason: reserved ? ('reserved' as const) : ('overlap' as const),
						paths: Object.freeze(overlapping.map((other) => other.compiled.path)),
						targets: Object.freeze(overlapping.map((other) => other.entry.target.node)),
					})
				: null
		return Object.freeze({
			...candidate,
			href: conflict ? candidate.canonicalHref : candidate.compiled.path,
			conflict,
		})
	})
	return Object.freeze({
		routes: Object.freeze(routes),
		conflicts: Object.freeze(routes.filter((route) => route.conflict !== null)),
	})
}

export function resolveWorkbenchDirectoryRoute(
	directory: WorkbenchRouteDirectory,
	pathname: string,
) {
	const location = normalizeWorkbenchPath(pathname)
	for (const route of directory.routes) {
		if (route.conflict) continue
		const params = matchWorkbenchRoute(route.compiled, location)
		if (!params || route.entry.placement.kind !== 'route') continue
		return Object.freeze({
			entry: route.entry,
			location,
			params,
			frame: route.entry.placement.frame,
		})
	}
	return undefined
}

export function getWorkbenchDirectoryConflicts(
	directory: WorkbenchRouteDirectory,
	pathname: string,
): readonly WorkbenchDirectoryRoute[] {
	return directory.conflicts.filter(
		(route) => matchWorkbenchRoute(route.compiled, pathname) !== null,
	)
}

export function getWorkbenchDirectoryHref(
	directory: WorkbenchRouteDirectory,
	target: PluginNodeAddress,
	path: string,
	frame?: WorkbenchFrame,
): string {
	const route = directory.routes.find(
		(candidate) =>
			pluginNodeAddressEqual(candidate.entry.target.node, target) &&
			matchWorkbenchRoute(candidate.compiled, path) !== null,
	)
	const declaredFrame =
		route?.entry.placement.kind === 'route' ? route.entry.placement.frame : 'shell'
	const requestedFrame = frame ?? declaredFrame
	// An explicit frame override must keep its canonical URL: the short URL has one declared frame.
	if (route && !route.conflict && requestedFrame === declaredFrame)
		return normalizeWorkbenchPath(path)
	return buildWorkbenchHref(target, path, requestedFrame)
}
