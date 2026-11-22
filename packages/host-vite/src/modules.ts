import { configSourcePlugin, createPluginSemanticsPlugin } from '@pluxel/rolldown/plugins'
import { perEnvironmentPlugin, type Plugin } from 'vite'

/** Compile Plugin and config declarations in each selected Vite module graph before evaluation. */
export function pluginModules(options: {
	readonly environments: readonly string[]
	readonly root: string
	/** A plugin package's manifest gives its exports their published identities. */
	readonly packageJsonPath?: string
}): Plugin {
	const { root, packageJsonPath } = options
	const environments = new Set(options.environments)
	return {
		...perEnvironmentPlugin('pluxel:plugin-modules', (environment) =>
			environments.has(environment.name)
				? [
						createPluginSemanticsPlugin({ root, packageJsonPath }).plugin as Plugin,
						configSourcePlugin() as Plugin,
					]
				: false,
		),
		enforce: 'pre',
	}
}
