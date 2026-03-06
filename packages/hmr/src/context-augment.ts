// Type-only module augmentation for HMR runtime config keys.
//
// Keep this in a dedicated file and import it from entrypoints that expose `Context.Config`
// (e.g. `@pluxel/hmr/host`, `@pluxel/hmr/services`) so consumers see these keys without
// having to import ConfigService directly.

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** ConfigService storage file path (workspace-relative unless absolute). */
			path?: string
			/** Workspace profile (generic). */
			profile?: string
			/** HMR profile (preferred). */
			hmrProfile?: string
		}
	}
}

export {}
