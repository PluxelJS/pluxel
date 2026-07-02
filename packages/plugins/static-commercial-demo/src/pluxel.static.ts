import { resolve } from 'node:path'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { CommercialDataPlugin } from './data-plugin.ts'
import { StaticCommercialPlugin } from './plugin.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-static-commercial-demo'

export const staticCommercialPlugins = [CommercialDataPlugin, StaticCommercialPlugin] as const
export const staticCommercialEnabledPlugins = [
	'CommercialDataPlugin',
	'StaticCommercialPlugin',
] as const

export default defineStaticRuntimeConfig({
	name: 'plugins-static-commercial-demo',
	profile: activeProfile,
	plugins: staticCommercialPlugins,
	configService: {
		mode: 'memory',
	},
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: staticCommercialEnabledPlugins },
	},
	logger: { preset: 'core' },
	pluginData: {
		dir: resolve(repoRoot, 'packages/plugins/static-commercial-demo/.pluxel/static/plugin-data'),
	},
	http: {
		management: true,
	},
})
