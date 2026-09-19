import { describe, expect, it } from 'vitest'
import {
	pluginSourceVitePlugins,
	type PluginSourceVitePluginsOptions,
} from '../../src/vite/plugin-source.ts'

type PluginSourceConfig = Readonly<{
	server?: Readonly<{
		watch?: Readonly<{ ignored?: readonly string[] }>
	}>
}>

function pluginSourceConfig(
	options: PluginSourceVitePluginsOptions = {},
	input: { server?: { watch?: null } } = {},
): PluginSourceConfig {
	const plugins = pluginSourceVitePlugins({
		...options,
		lintGuard: false,
		configSource: false,
	}) as unknown as Array<{
		name?: string
		config?: (config: typeof input) => PluginSourceConfig
	}>
	const plugin = plugins.find((candidate) => candidate.name === 'pluxel:plugin-source')
	if (!plugin?.config) throw new Error('plugin source config plugin was not created')
	return plugin.config(input)
}

describe('Pluxel Plugin source Vite watcher policy', () => {
	it('ignores generated files by default while preserving an explicitly disabled watcher', () => {
		expect(pluginSourceConfig()).toMatchObject({
			server: { watch: { ignored: ['**/.pluxel/**'] } },
		})
		expect(pluginSourceConfig({}, { server: { watch: null } })).not.toHaveProperty('server')
	})
})
