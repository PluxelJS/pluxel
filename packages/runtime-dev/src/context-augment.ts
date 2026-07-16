import type { PluginArtifactCompilerConfig } from './workbench/PluginArtifactCompiler'

declare module '@pluxel/core' {
	namespace Context {
		interface Config {
			/** HMR plugin artifact compiler config. */
			pluginArtifactCompiler?: PluginArtifactCompilerConfig
		}
	}
}
