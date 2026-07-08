import type { HttpServiceConfig } from './services/http/HttpService'
import type { ExtensionServiceConfig } from './services/plugin-interaction/ExtensionService'
import type { AdminAccessConfig } from './services/admin-access/types'

// Type-only module augmentation for @pluxel/runtime-owned config keys.
//
// Vite/loader-hmr-specific config keys must live in @pluxel/runtime-dynamic/hmr, so runtime remains a clean kernel.

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** ConfigService storage file path (workspace-relative unless absolute). */
			path?: string
			/** Workspace profile (generic). */
			profile?: string
			/** HTTP runtime settings. Management internals are owned by route launchers. */
			http?: HttpServiceConfig
			/** Host admin surface enablement and access policy. */
			adminAccess?: AdminAccessConfig
			/** UI extension registry settings. */
			extensionService?: ExtensionServiceConfig
		}
	}
}
