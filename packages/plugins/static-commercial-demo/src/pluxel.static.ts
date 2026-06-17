import { defineStaticRuntime } from '@pluxel/runtime-static'
import { StaticCommercialPlugin } from './plugin.ts'

export const staticCommercialPlugins = [StaticCommercialPlugin] as const
export const staticCommercialEnabledPlugins = ['StaticCommercialPlugin'] as const

export default defineStaticRuntime({
	name: 'plugins-static-commercial-demo',
	plugins: staticCommercialPlugins,
})
