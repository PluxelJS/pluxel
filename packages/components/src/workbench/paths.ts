export const WORKBENCH_ROUTE_PREFIX = '/ext' as const
export const WORKBENCH_STANDALONE_ROUTE_PREFIX = '/ext-standalone' as const

export type WorkbenchFrame = 'shell' | 'standalone'
export type WorkbenchRoutePrefix =
	| typeof WORKBENCH_ROUTE_PREFIX
	| typeof WORKBENCH_STANDALONE_ROUTE_PREFIX

export function getWorkbenchRoutePrefix(frame: WorkbenchFrame): WorkbenchRoutePrefix {
	return frame === 'standalone' ? WORKBENCH_STANDALONE_ROUTE_PREFIX : WORKBENCH_ROUTE_PREFIX
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
