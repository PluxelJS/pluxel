import { fileURLToPath } from 'node:url'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { dirname, resolve } from 'pathe'
import { PluginEventsDeclaredConsumer, PluginEventsDeclaredProducer } from './demo/PluginEventsDemo'
import { PluginFeatureDepsConsumer, PluginFeatureDepsProvider } from './demo/PluginFeatureDepsDemo'
import { PluginHttpRoutesDemo } from './demo/PluginHttpRoutesDemo'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const staticDataRoot = resolve(repoRoot, 'packages/plugins/host/.pluxel/static')

export const staticDemoPlugins = [
	PluginEventsDeclaredProducer,
	PluginEventsDeclaredConsumer,
	PluginFeatureDepsProvider,
	PluginFeatureDepsConsumer,
	PluginHttpRoutesDemo,
] as const

export const staticDemoEnabledPlugins = [
	'PluginEventsDeclaredProducer',
	'PluginEventsDeclaredConsumer',
	'PluginFeatureDepsProvider',
	'PluginFeatureDepsConsumer',
	'PluginHttpRoutesDemo',
] as const

export default defineStaticRuntimeConfig({
	name: 'plugins-host-static',
	plugins: staticDemoPlugins,
	runtimeState: {
		snapshot: { enabled: staticDemoEnabledPlugins },
	},
	webManagement: {
		enabled: true,
		access: { exposure: 'private' },
	},
	logger: { preset: 'core' },
	persistence: resolve(staticDataRoot, 'persistence'),
})
