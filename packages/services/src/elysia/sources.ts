/**
 * Shared identities required by elysia() and its Node listener. Safe to import before
 * runHostApplication(): this metadata does not evaluate service tokens or Elysia.
 * The application declares these packages directly; Core and Host are always shared.
 */
export const elysiaSharedPackages: readonly string[] = Object.freeze([
	'@pluxel/services',
	'elysia',
	'typebox',
	'exact-mirror',
])
