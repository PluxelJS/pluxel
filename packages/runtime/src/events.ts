// Type-level bridge for runtime event contracts.
//
// Why:
// - Plugin authors augment `@pluxel/runtime`, not `@pluxel/context`.
// - The canonical event registry still lives in `@pluxel/core/services`.
// - `RuntimeEvents` keeps the augmentation surface flat, which is easier for TS tooling
//   and avoids namespace-export bugs in the current dts bundler.

export type ResolverCacheInvalidationDetail = {
	/** Best-effort source tag (e.g. "packageService", "loaderHmr"). */
	by?: string
	/** Optional reason (e.g. "install", "remove", "lockfile-change"). */
	reason?: string
	/** Optional list of affected package targets/specifiers. */
	targets?: readonly string[]
}

export interface PluxelRuntimeEventMap {
	/**
	 * Fired when ScanService clears its module-resolution caches (exsolve cache map + entry resolver).
	 *
	 * Consumers (HMR runner, package loaders, long-lived tooling) should treat this as a signal to
	 * drop any derived/cached resolution results so future imports can observe newly installed/removed
	 * dependencies and updated export conditions.
	 */
	'runtime:resolverCacheInvalidated': [detail?: ResolverCacheInvalidationDetail]
}

export interface RuntimeEvents extends PluxelRuntimeEventMap {}

declare module '@pluxel/core' {
	interface Events extends RuntimeEvents {}
}
