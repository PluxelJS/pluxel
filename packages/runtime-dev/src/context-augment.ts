import type { ManagementCompilerServiceConfig } from './management/ManagementCompilerService'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** HMR UI management compiler config. */
			managementCompiler?: ManagementCompilerServiceConfig
		}
	}
}
