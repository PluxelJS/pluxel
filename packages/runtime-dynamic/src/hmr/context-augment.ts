import type { LoaderHmrConfig } from './engine/LoaderHmrService'
import type { ExtensionCompilerServiceConfig } from '@pluxel/runtime-dev'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** Loader HMR controller config (set by HMR hosts for observability). */
			loaderHmr?: LoaderHmrConfig
			/** HMR UI extension compiler config. */
			extensionCompiler?: ExtensionCompilerServiceConfig
		}
	}
}
