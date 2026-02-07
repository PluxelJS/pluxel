// packages/hmr/src/events.ts
//
// Type-level bridge for event contracts.
//
// Why:
// - Plugin authors prefer augmenting `@pluxel/hmr` (not `@pluxel/context`).
// - The canonical event map lives in `@pluxel/core/services` (EventsService generic).
// - This file bridges `@pluxel/hmr` event declarations into that canonical event map.

declare module '@pluxel/hmr' {
	export namespace Context {
		interface Events {
			/**
			 * Fired when ScanService clears its module-resolution caches (exsolve cache map + entry resolver).
			 *
			 * Consumers (HMR runner, package loaders, long-lived tooling) should treat this as a signal to
			 * drop any derived/cached resolution results so future imports can observe newly installed/removed
			 * dependencies and updated export conditions.
			 */
			'runtime:resolverCacheInvalidated': [
				detail?: {
					/** Best-effort source tag (e.g. "packageService", "hmrService"). */
					by?: string
					/** Optional reason (e.g. "install", "remove", "lockfile-change"). */
					reason?: string
					/** Optional list of affected package targets/specifiers. */
					targets?: readonly string[]
				},
			]
		}
	}
}

declare module '@pluxel/core/services' {
	// Merge all `@pluxel/hmr` event declarations into the canonical registry.
	// NOTE:
	// Do not self-import `@pluxel/hmr` here: depending on `customConditions`, TS may resolve it to `dist`
	// and include both source + dist module augmentations in the same program, causing declaration conflicts.
	type HmrEvents = import('./index').Context.Events
	interface Events extends HmrEvents {}
}
