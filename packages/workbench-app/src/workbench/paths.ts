export const WORKBENCH_ROUTE_PREFIX = '/workbench' as const
export const WORKBENCH_STANDALONE_ROUTE_PREFIX = '/workbench-standalone' as const

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
	pluginName: string,
	path: string,
	frame: WorkbenchFrame = 'shell',
): string {
	const normalizedPath = normalizeWorkbenchPath(path)
	const encodedName = (() => {
		try {
			return encodeURIComponent(pluginName)
		} catch {
			return pluginName
		}
	})()
	const prefix = getWorkbenchRoutePrefix(frame)
	return `${prefix}/${encodedName}${normalizedPath}`
}

export type ParsedWorkbenchHref = Readonly<{
	pluginName: string
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
	const separator = tail.indexOf('/')
	const encodedPluginName = separator === -1 ? tail : tail.slice(0, separator)
	if (!encodedPluginName) return undefined
	const path = separator === -1 ? '' : normalizeWorkbenchPath(tail.slice(separator))
	return Object.freeze({ pluginName: decodeSegment(encodedPluginName), path, frame })
}

function decodeSegment(value: string): string {
	try {
		return decodeURIComponent(value)
	} catch {
		return value
	}
}
