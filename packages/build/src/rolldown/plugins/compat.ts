export type ViteCompatPlugin<A = any> = import('rolldown').Plugin<A> & {
	/**
	 * Vite-only hook; ignored by rolldown.
	 */
	hotUpdate?: unknown
	/**
	 * Vite-only hook; ignored by rolldown.
	 */
	apply?: unknown
}

export function allowOptionalQuerySuffix(pattern: string): string {
	// Vite module ids may contain query strings; allow them without requiring special glob syntax.
	// Only apply to "file-like" patterns to avoid breaking directory globs (e.g. `**/node_modules/**`).
	if (!pattern) return pattern
	if (pattern.startsWith('!')) return `!${allowOptionalQuerySuffix(pattern.slice(1))}`

	const fileLikeSuffixes = [
		'.d.ts',
		'.d.mts',
		'.d.cts',
		'.ts',
		'.tsx',
		'.mts',
		'.cts',
		'.js',
		'.jsx',
		'.mjs',
		'.cjs',
	] as const
	for (const suffix of fileLikeSuffixes) {
		if (pattern.endsWith(suffix)) return `${pattern}*`
	}
	return pattern
}
