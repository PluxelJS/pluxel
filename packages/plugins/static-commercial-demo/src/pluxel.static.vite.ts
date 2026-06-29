import { resolve } from 'node:path'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static/vite'
import { staticCommercialEnabledPlugins, staticCommercialPlugins } from './pluxel.static.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-static-commercial-demo'

export default defineStaticRuntimeConfig({
	name: 'plugins-static-commercial-demo',
	plugins: staticCommercialPlugins,
	configService: {
		mode: 'memory',
	},
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: staticCommercialEnabledPlugins },
	},
	context: {
		profile: activeProfile,
		logger: { preset: 'core' },
		pluginData: {
			dir: resolve(repoRoot, 'packages/plugins/static-commercial-demo/.pluxel/static/plugin-data'),
		},
		http: {
			controlPlane: { web: true, rpc: true, sse: true },
			uiAssets: 'hmr-server',
		},
		extensionService: { enabled: true },
	},
})
