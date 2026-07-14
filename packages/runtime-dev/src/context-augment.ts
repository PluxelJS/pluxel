import type { WorkbenchCompilerServiceConfig } from './workbench/WorkbenchCompilerService'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** HMR UI workbench compiler config. */
			workbenchCompiler?: WorkbenchCompilerServiceConfig
		}
	}
}
