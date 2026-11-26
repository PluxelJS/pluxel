import { resolve } from 'node:path'
import type { InlineConfig } from 'vite'
import { defineWxtModule } from 'wxt/modules'

export default defineWxtModule((wxt) => {
	// Entry discovery and postinstall type generation can run before workspace libraries are built.
	async function compilePlugins(config: InlineConfig) {
		const { pluginModules } = await import('@pluxel/host-vite/modules')
		const root = wxt.config.root
		config.plugins ??= []
		config.plugins.push(
			pluginModules({
				root,
				packageJsonPath: resolve(root, 'package.json'),
				environments: ['client'],
			}),
		)
	}
	wxt.hook('vite:devServer:extendConfig', compilePlugins)
	wxt.hook('vite:build:extendConfig', (_, config) => compilePlugins(config))
})
