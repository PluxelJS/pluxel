import type { ExtensionCompilerServiceConfig } from './extensions/ExtensionCompilerService'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** HMR UI extension compiler config. */
			extensionCompiler?: ExtensionCompilerServiceConfig
		}
	}
}
