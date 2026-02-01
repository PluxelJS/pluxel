export const EXTENSION_ROUTE_PREFIX = '/ext' as const
export const EXTENSION_STANDALONE_ROUTE_PREFIX = '/ext-standalone' as const

export type ExtensionFrame = 'shell' | 'standalone'
export type ExtensionRoutePrefix =
	| typeof EXTENSION_ROUTE_PREFIX
	| typeof EXTENSION_STANDALONE_ROUTE_PREFIX

export function getExtensionRoutePrefix(frame: ExtensionFrame): ExtensionRoutePrefix {
	return frame === 'standalone' ? EXTENSION_STANDALONE_ROUTE_PREFIX : EXTENSION_ROUTE_PREFIX
}

/**
 * Normalize a plugin-provided route path.
 *
 * - Empty or `/` -> `''` (represents the plugin root)
 * - Trims and removes `.`, `..` segments
 * - Ensures leading slash for non-empty paths
 */
export function normalizeExtensionRouteSubPath(path: string): string {
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

export function buildExtensionHref(
	pluginName: string,
	path: string,
	frame: ExtensionFrame = 'shell',
): string {
	const normalizedPath = normalizeExtensionRouteSubPath(path)
	const encodedName = (() => {
		try {
			return encodeURIComponent(pluginName)
		} catch {
			return pluginName
		}
	})()
	const prefix = getExtensionRoutePrefix(frame)
	return `${prefix}/${encodedName}${normalizedPath}`
}

