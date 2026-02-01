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
	prefix: '/ext' | '/ext-standalone'
}): string {
	const { locationPath, rawName, prefix } = opts
	if (!locationPath) return ''
	const match = locationPath.match(
		prefix === '/ext' ? /^\/ext\/([^/]+)(.*)$/ : /^\/ext-standalone\/([^/]+)(.*)$/,
	)
	if (!match) return ''
	const [, segment, rest] = match
	if (segment !== rawName) return ''
	return normalizeExtensionRestPath(rest)
}

