import { defineStaticRuntime } from '@pluxel/runtime-static'
import {
	PluginEventsDeclaredConsumer,
	PluginEventsDeclaredProducer,
	PluginFeatureDepsConsumer,
	PluginFeatureDepsProvider,
	PluginHttpRoutesDemo,
	PluginHttpWorkerDemo,
	PluginVaultDemo,
} from './demo'

export const staticDemoPlugins = [
	PluginEventsDeclaredProducer,
	PluginEventsDeclaredConsumer,
	PluginFeatureDepsProvider,
	PluginFeatureDepsConsumer,
	PluginHttpRoutesDemo,
	PluginHttpWorkerDemo,
	PluginVaultDemo,
] as const

export const staticDemoEnabledPlugins = [
	'PluginEventsDeclaredProducer',
	'PluginEventsDeclaredConsumer',
	'PluginFeatureDepsProvider',
	'PluginFeatureDepsConsumer',
	'PluginHttpRoutesDemo',
	'PluginHttpWorkerDemo',
	'PluginVaultDemo',
] as const

export default defineStaticRuntime({
	name: 'plugins-host-static',
	plugins: staticDemoPlugins,
})
