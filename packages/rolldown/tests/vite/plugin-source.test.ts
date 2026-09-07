import { describe, expect, it } from 'vitest'
import {
	pluxelRuntimeSourceVitePlugins,
	type PluxelRuntimeSourceVitePluginsOptions,
} from '../../src/vite/plugin-source.ts'

type RuntimeSourceConfig = Readonly<{
	server?: Readonly<{
		watch?: Readonly<{ ignored?: readonly string[] }>
	}>
}>

function runtimeSourceConfig(
	options: PluxelRuntimeSourceVitePluginsOptions = {},
	input: { server?: { watch?: null } } = {},
): RuntimeSourceConfig {
	const plugins = pluxelRuntimeSourceVitePlugins({
		...options,
		lintGuard: false,
		configSource: false,
	}) as unknown as Array<{
		name?: string
		config?: (config: typeof input) => RuntimeSourceConfig
	}>
	const plugin = plugins.find((candidate) => candidate.name === 'pluxel:runtime-source')
	if (!plugin?.config) throw new Error('runtime source config plugin was not created')
	return plugin.config(input)
}

describe('Pluxel runtime source Vite watcher policy', () => {
	it('ignores generated files by default while preserving an explicitly disabled watcher', () => {
		expect(runtimeSourceConfig()).toMatchObject({
			server: { watch: { ignored: ['**/.pluxel/**'] } },
		})
		expect(runtimeSourceConfig({}, { server: { watch: null } })).not.toHaveProperty('server')
	})
})
