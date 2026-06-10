export const PLUXEL_CONDITION_RUNTIME_DYNAMIC = '@pluxel/runtime-dynamic' as const
export const PLUXEL_CONDITION_SOURCE = '@pluxel/source' as const

/**
 * Default export conditions used by loader HMR when resolving plugin package entries.
 *
 * Notes:
 * - `@pluxel/runtime-dynamic` is the plugin-package loader-hmr source condition.
 * - `@pluxel/source` is for internal workspace packages.
 * - `module` is kept for legacy fields that still key off it (some packages/tooling do).
 * - `default` is included to match Node's default export resolution behavior.
 */
export const PLUXEL_LOADER_HMR_WORKSPACE_CONDITIONS_WITH_SOURCE = [
	PLUXEL_CONDITION_RUNTIME_DYNAMIC,
	PLUXEL_CONDITION_SOURCE,
	'import',
	'module',
	'default',
] as const

/**
 * Conditions used when we want to prefer published/built outputs (dist) over dev-only conditions.
 */
export const PLUXEL_DIST_EXPORT_CONDITIONS = ['import', 'default', 'require'] as const
