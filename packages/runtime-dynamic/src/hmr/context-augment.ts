import type { LoaderHmrConfig } from './engine/LoaderHmrService'
import type { ManagementCompilerServiceConfig } from '@pluxel/runtime-dev'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** Loader HMR controller config (set by HMR hosts for observability). */
			loaderHmr?: LoaderHmrConfig
			/** HMR Management UI compiler config. */
			managementCompiler?: ManagementCompilerServiceConfig
		}
	}
}
