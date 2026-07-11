import { resolve } from 'node:path'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { CommercialDataPlugin } from './data-plugin.ts'
import { StaticCommercialPlugin } from './plugin.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const staticDataRoot = resolve(repoRoot, 'packages/plugins/static-commercial-demo/.pluxel/static')

export const staticCommercialPlugins = [CommercialDataPlugin, StaticCommercialPlugin] as const
export const staticCommercialEnabledPlugins = [
	'CommercialDataPlugin',
	'StaticCommercialPlugin',
] as const

export default defineStaticRuntimeConfig({
	name: 'plugins-static-commercial-demo',
	plugins: staticCommercialPlugins,
	runtimeState: {
		snapshot: { enabled: staticCommercialEnabledPlugins },
	},
	logger: { preset: 'core' },
	persistence: resolve(staticDataRoot, 'persistence'),
	webManagement: { enabled: true, access: { exposure: 'private' } },
})
