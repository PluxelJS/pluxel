import type { ExtensionRoutePrefix } from '../../../extension/paths'
import { EXTENSION_ROUTE_PREFIX } from '../../../extension/paths'

export function decodeURIComponentSafe(input: string): string {
	try {
		return decodeURIComponent(input)
	} catch {
		return input
	}
}

export function normalizeExtensionRestPath(raw?: string): string {
	if (!raw) return ''
	const decoded = decodeURIComponentSafe(raw)
	const segments = decoded
		.split('/')
		.map((segment) => segment.trim())
		.filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
	if (segments.length === 0) return ''
	return `/${segments.join('/')}`
}

export function readRestPathFromLocation(opts: {
	locationPath: string | null | undefined
	rawName: string
	prefix: ExtensionRoutePrefix
}): string {
	const { locationPath, rawName, prefix } = opts
	if (!locationPath) return ''
	const match = locationPath.match(
		prefix === EXTENSION_ROUTE_PREFIX ? /^\/ext\/([^/]+)(.*)$/ : /^\/ext-standalone\/([^/]+)(.*)$/,
	)
	if (!match) return ''
	const [, segment, rest] = match
	if (segment !== rawName) return ''
	return normalizeExtensionRestPath(rest)
}
