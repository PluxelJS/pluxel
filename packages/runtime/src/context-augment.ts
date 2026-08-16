import type { HttpServiceConfig } from './services/http/HttpService'
import type { AdminAccessConfig } from './services/admin-access/types'
import type { WorkbenchConfig } from './workbench-config'

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
			/** HTTP runtime settings. Workbench internals are owned by route launchers. */
			http?: HttpServiceConfig
			/** Host admin surface enablement and access policy. */
			adminAccess?: AdminAccessConfig
			/** Optional Workbench Plane capability and access policy. */
			workbench?: WorkbenchConfig
			/** @internal Deployment-owned root containing assembled Workbench artifacts. */
			workbenchArtifactRoot?: string
			/** @internal Dynamic/package hosts provide package artifact resolution explicitly. */
			workbenchArtifactResolver?: (
				root: import('@pluxel/core').Context,
				owner: import('@pluxel/core').PluginNodeAddressSnapshot,
				artifactName: string,
			) => string | null | Promise<string | null>
		}
	}
}
