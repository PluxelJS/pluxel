import { fileURLToPath } from 'node:url'
import { defineDynamicRuntimeConfig } from '@pluxel/runtime-dynamic'
import { dirname, resolve } from 'pathe'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const activeProfile = process.env.PLUXEL_HMR_PROFILE ?? 'plugins-host'
const configPath = process.env.PLUXEL_HMR_CONFIG ?? 'packages/plugins/host/pluxel.loader.hmr.jsonc'
const enabledDemoPlugins = [
	'PluginEventsDeclaredProducer',
	'PluginEventsDeclaredConsumer',
	'PluginFeatureDepsProvider',
	'PluginFeatureDepsConsumer',
	'PluginHttpRoutesDemo',
	'PluginHttpWorkerDemo',
] as const

export default defineDynamicRuntimeConfig({
	root: repoRoot,
	configPath,
	profile: activeProfile,
	logsDir: 'packages/plugins/host/logs',
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: enabledDemoPlugins },
	},
})
