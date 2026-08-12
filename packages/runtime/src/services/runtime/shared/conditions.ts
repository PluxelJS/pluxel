export const PLUXEL_CONDITION_HMR = '@pluxel/hmr' as const
export const COMMUNITY_CONDITION_DEVELOPMENT = 'development' as const
export const PLUXEL_CONDITION_SOURCE = '@pluxel/source' as const

/**
 * Default export conditions used by loader HMR when resolving plugin package entries.
 *
 * Notes:
 * - `@pluxel/hmr` is the plugin-package loader-hmr source condition.
 * - `development` is the community condition for framework-neutral development entries.
 * - `@pluxel/source` is for internal workspace packages.
 * - `default` is included to match Node's default export resolution behavior.
 */
export const PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE = [
	PLUXEL_CONDITION_HMR,
	COMMUNITY_CONDITION_DEVELOPMENT,
	PLUXEL_CONDITION_SOURCE,
	'import',
	'default',
] as const

export function withPluxelHmrConditions(conditions: readonly string[]): string[] {
	const out: string[] = []
	const seen = new Set<string>()
	for (const condition of [
		PLUXEL_CONDITION_HMR,
		COMMUNITY_CONDITION_DEVELOPMENT,
		PLUXEL_CONDITION_SOURCE,
		...conditions,
	]) {
		if (seen.has(condition)) continue
		seen.add(condition)
		out.push(condition)
	}
	return out
}

/**
 * Conditions used when we want to prefer published/built outputs (dist) over dev-only conditions.
 */
export const PLUXEL_DIST_EXPORT_CONDITIONS = ['import', 'default', 'require'] as const
