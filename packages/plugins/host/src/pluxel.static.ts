import { fileURLToPath } from 'node:url'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { dirname, resolve } from 'pathe'
import { PluginEventsDeclaredConsumer, PluginEventsDeclaredProducer } from './demo/PluginEventsDemo'
import { PluginFeatureDepsConsumer, PluginFeatureDepsProvider } from './demo/PluginFeatureDepsDemo'
import { PluginHttpRoutesDemo } from './demo/PluginHttpRoutesDemo'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-host-static'

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
	profile: activeProfile,
	plugins: staticDemoPlugins,
	configService: {
		mode: 'memory',
	},
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: staticDemoEnabledPlugins },
	},
	management: {
		enabled: true,
		access: { exposure: 'private' },
	},
	logger: { preset: 'core' },
	pluginData: {
		dir: resolve(repoRoot, 'packages/plugins/host/.pluxel/static/plugin-data'),
	},
})
