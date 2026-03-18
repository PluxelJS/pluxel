import type { HttpServiceConfig } from './services/http/HttpService'
import type { ExtensionServiceConfig } from './services/plugin-interaction/ExtensionService'

// Type-only module augmentation for @pluxel/runtime-owned config keys.
//
// HMR/Vite-specific config keys must live in @pluxel/hmr (dev-only), so runtime remains a clean kernel.

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** ConfigService storage file path (workspace-relative unless absolute). */
			path?: string
			/** Workspace profile (generic). */
			profile?: string
			/** HTTP/control-plane runtime settings. */
			http?: HttpServiceConfig
			/** UI extension registry/compiler mode. */
			extensionService?: ExtensionServiceConfig
		}
	}
}
