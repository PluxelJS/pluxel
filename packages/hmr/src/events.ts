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
		interface Events {}
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
