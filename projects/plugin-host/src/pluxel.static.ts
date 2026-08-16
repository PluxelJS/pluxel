import { resolve } from 'node:path'
import { pluginNodeAddressOf } from '@pluxel/runtime'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { PluginEventsDeclaredConsumer, PluginEventsDeclaredProducer } from './demo/PluginEventsDemo'
import { PluginHttpRoutesDemo } from './demo/PluginHttpRoutesDemo'
import {
	PluginOptionalIntegrationConsumer,
	PluginOptionalIntegrationProvider,
} from './demo/PluginOptionalIntegrationDemo'

export const staticDemoPlugins = [
	PluginEventsDeclaredProducer,
	PluginEventsDeclaredConsumer,
	PluginOptionalIntegrationProvider,
	PluginOptionalIntegrationConsumer,
	PluginHttpRoutesDemo,
] as const

export const staticDemoEnabledPlugins = staticDemoPlugins.map(pluginNodeAddressOf)

export default defineStaticRuntime({
	name: 'plugins-host-static',
	plugins: staticDemoPlugins,
	configure({ env, deployment }) {
		const staticDataRoot = env.PLUXEL_STATIC_DATA_ROOT
			? resolve(env.PLUXEL_STATIC_DATA_ROOT)
			: resolve(deployment?.root ?? resolve(import.meta.dirname, '..'), '.pluxel/static')
		return {
			runtimeState: {
				snapshot: { enabled: staticDemoEnabledPlugins },
			},
			workbench:
				env.PLUXEL_WORKBENCH === 'false'
					? false
					: { enabled: true, access: { exposure: 'private' } },
			persistence: resolve(staticDataRoot, 'persistence'),
		}
	},
})
