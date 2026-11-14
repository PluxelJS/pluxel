export const controlEntry = (directory: string) => ({
	types: `${directory}/index.d.mts`,
	import: `${directory}/index.mjs`,
	default: `${directory}/index.mjs`,
})

/** Own the marked generated subpath, while preserving author root conditions and exports. */
export function addControlExport(
	value: unknown,
	entry: ReturnType<typeof controlEntry>,
	marker: unknown,
	field: string,
): Record<string, unknown> {
	const subpaths =
		value &&
		typeof value === 'object' &&
		!Array.isArray(value) &&
		Object.keys(value).some((key) => key.startsWith('.'))
	const exports: Record<string, unknown> =
		value === undefined ? {} : subpaths ? { ...(value as Record<string, unknown>) } : { '.': value }
	const existing = exports['./control']
	if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) {
		const previousDirectory =
			typeof marker === 'string' && marker.endsWith('/manifest.json')
				? marker.slice(0, -'/manifest.json'.length)
				: undefined
		if (
			!previousDirectory ||
			JSON.stringify(existing) !== JSON.stringify(controlEntry(previousDirectory))
		)
			throw new Error(
				`${field}['./control'] belongs to the author; choose another export before enabling generated Plugin control materials`,
			)
	}
	if (marker !== undefined && (typeof marker !== 'string' || !marker.endsWith('/manifest.json')))
		throw new Error('pluxel.control must name the generated control/manifest.json')
	return { ...exports, './control': entry }
}
