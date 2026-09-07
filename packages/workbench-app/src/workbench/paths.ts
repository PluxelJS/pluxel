import { formatPluginNodeRoute, parsePluginNodeRoute, type PluginNodeAddress } from '@pluxel/core'
export const WORKBENCH_ROUTE_PREFIX = '/workbench' as const
export const WORKBENCH_STANDALONE_ROUTE_PREFIX = '/workbench-standalone' as const
export const PLUGIN_DETAIL_ROUTE_PREFIX = '/plugins' as const

export type WorkbenchFrame = 'shell' | 'standalone'
export type WorkbenchRoutePrefix =
	| typeof WORKBENCH_ROUTE_PREFIX
	| typeof WORKBENCH_STANDALONE_ROUTE_PREFIX

export function getWorkbenchRoutePrefix(frame: WorkbenchFrame): WorkbenchRoutePrefix {
	return frame === 'standalone' ? WORKBENCH_STANDALONE_ROUTE_PREFIX : WORKBENCH_ROUTE_PREFIX
}

export function getWorkbenchFrame(prefix: WorkbenchRoutePrefix): WorkbenchFrame {
	return prefix === WORKBENCH_STANDALONE_ROUTE_PREFIX ? 'standalone' : 'shell'
}

/**
 * Normalize a plugin-provided route path.
 *
 * - Empty or `/` -> `''` (represents the plugin root)
 * - Trims and removes `.`, `..` segments
 * - Ensures leading slash for non-empty paths
 */
export function normalizeWorkbenchPath(path: string): string {
	if (!path) return ''
	const trimmed = path.trim()
	if (!trimmed || trimmed === '/') return ''
	const segments = trimmed
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

export function buildWorkbenchHref(
	target: PluginNodeAddress,
	path: string,
	frame: WorkbenchFrame = 'shell',
): string {
	const normalizedPath = normalizeWorkbenchPath(path)
	const prefix = getWorkbenchRoutePrefix(frame)
	return `${prefix}/${formatPluginNodeRoute(target)}${normalizedPath}`
}

export function buildPluginDetailHref(target: PluginNodeAddress, path = ''): string {
	return `${PLUGIN_DETAIL_ROUTE_PREFIX}/${formatPluginNodeRoute(target)}${normalizeWorkbenchPath(path)}`
}

export function parsePluginDetailHref(
	pathname: string,
): Readonly<{ target: PluginNodeAddress; path: string }> | undefined {
	const marker = `${PLUGIN_DETAIL_ROUTE_PREFIX}/`
	if (!pathname.startsWith(marker)) return undefined
	const rawSegments = pathname.slice(marker.length).split('/')
	try {
		const { nodeAddress: target, consumedSegments } = parsePluginNodeRoute(rawSegments)
		return Object.freeze({
			target,
			path: normalizeWorkbenchPath(rawSegments.slice(consumedSegments).join('/')),
		})
	} catch {
		return undefined
	}
}

export type ParsedWorkbenchHref = Readonly<{
	target: PluginNodeAddress
	path: string
	frame: WorkbenchFrame
}>

export function parseWorkbenchHref(pathname: string): ParsedWorkbenchHref | undefined {
	return (
		parseWorkbenchHrefWithPrefix(pathname, WORKBENCH_ROUTE_PREFIX, 'shell') ??
		parseWorkbenchHrefWithPrefix(pathname, WORKBENCH_STANDALONE_ROUTE_PREFIX, 'standalone')
	)
}

function parseWorkbenchHrefWithPrefix(
	pathname: string,
	prefix: WorkbenchRoutePrefix,
	frame: WorkbenchFrame,
): ParsedWorkbenchHref | undefined {
	const marker = `${prefix}/`
	if (!pathname.startsWith(marker)) return undefined
	const tail = pathname.slice(marker.length)
	if (!tail) return undefined
	const rawSegments = tail.split('/')
	try {
		const { nodeAddress: target, consumedSegments } = parsePluginNodeRoute(rawSegments)
		const path = normalizeWorkbenchPath(rawSegments.slice(consumedSegments).join('/'))
		return Object.freeze({ target, path, frame })
	} catch {
		return undefined
	}
}
