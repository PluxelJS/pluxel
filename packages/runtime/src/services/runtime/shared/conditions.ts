export const PLUXEL_CONDITION_HMR = '@pluxel/runtime' as const
export const PLUXEL_CONDITION_SOURCE = '@pluxel/source' as const

/**
 * Default export conditions used by Pluxel HMR when resolving workspace package entries.
 *
 * Notes:
 * - `module` is kept for legacy fields that still key off it (some packages/tooling do).
 * - `default` is included to match Node's default export resolution behavior.
 */
export const PLUXEL_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE = [
	PLUXEL_CONDITION_HMR,
	PLUXEL_CONDITION_SOURCE,
	'import',
	'module',
	'default',
] as const

/**
 * Conditions used when we want to prefer published/built outputs (dist) over dev-only conditions.
 */
export const PLUXEL_DIST_EXPORT_CONDITIONS = ['import', 'default', 'require'] as const
