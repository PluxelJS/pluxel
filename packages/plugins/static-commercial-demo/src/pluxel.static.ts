import { defineStaticRuntime } from '@pluxel/runtime-static'
import { CommercialDataPlugin } from './data-plugin.ts'
import { StaticCommercialPlugin } from './plugin.ts'

export const staticCommercialPlugins = [CommercialDataPlugin, StaticCommercialPlugin] as const
export const staticCommercialEnabledPlugins = [
	'CommercialDataPlugin',
	'StaticCommercialPlugin',
] as const

export default defineStaticRuntime({
	name: 'plugins-static-commercial-demo',
	plugins: staticCommercialPlugins,
})
