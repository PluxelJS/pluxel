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
		// biome-ignore lint/suspicious/noEmptyInterface: plugin/app will augment
		interface Events {}
	}
}

declare module '@pluxel/core/services' {
	// Merge all `@pluxel/hmr` event declarations into the canonical registry.
	type HmrEvents = import('@pluxel/hmr').Context.Events
	interface Events extends HmrEvents {}
}
