export const EXTRA_BASE_PROVIDERS = 'pluxel:baseProviders' as const
export const EXTRA_FORKS = 'pluxel:forks' as const
export const EXTRA_DEP_OVERRIDES = 'pluxel:depOverrides' as const
export const EXTRA_BUILTINS_KNOWN = 'pluxel:builtinsKnown' as const

/**
 * Global base-provider selection.
 * key: abstract base token name (usually ctor.name)
 * val: provider plugin id
 */
export type BaseProvidersExtra = Record<string, string>

/**
 * Fork catalog (so forks can be restarted across reloads).
 * key: original plugin id
 * val: list of forkIds (the part after '#')
 */
export type ForksExtra = Record<string, string[]>

/**
 * Per-plugin dependency overrides (constructor parameter tokens).
 * key: consumer plugin id
 * val: index -> target plugin id (may include '#')
 */
export type DepOverridesExtra = Record<string, Record<number, string>>

/**
 * Builtins "known" catalog.
 *
 * Purpose:
 * - seed default-enabled builtins only once (first encounter);
 * - never re-enable a builtin the user has disabled (or auto-disabled due to MissingDependency)
 *   on subsequent startups.
 */
export type BuiltinsKnownExtra = Record<string, 1>
