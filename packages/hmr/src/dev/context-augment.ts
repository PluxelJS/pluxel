import type { HMRConfig } from './hmr/HMRService'
import type { ExtensionCompilerServiceConfig } from './extensions/ExtensionCompilerService'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** Dev-only HMR controller config (set by dev hosts for observability). */
			hmrService?: HMRConfig
			/** Dev-only UI extension compiler config. */
			extensionCompiler?: ExtensionCompilerServiceConfig
		}
	}
}
