import { resolve } from 'node:path'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { AutheliaOidcDemoPlugin } from './plugin.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'plugins-authelia-oidc-demo'

export const autheliaOidcDemoPlugins = [AutheliaOidcDemoPlugin] as const
export const autheliaOidcDemoEnabledPlugins = [] as const

export default defineStaticRuntimeConfig({
	name: 'plugins-authelia-oidc-demo',
	profile: activeProfile,
	plugins: autheliaOidcDemoPlugins,
	configService: {
		mode: 'memory',
	},
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: autheliaOidcDemoEnabledPlugins },
	},
	logger: { preset: 'core' },
	pluginData: {
		dir: resolve(repoRoot, 'packages/plugins/authelia-oidc-demo/.pluxel/static/plugin-data'),
	},
	adminAccess: {
		enabled: true,
		exposure: 'public',
		oidc: {
			issuer: process.env.PLUXEL_AUTHELIA_ISSUER ?? 'http://127.0.0.1:9091',
			audience:
				process.env.PLUXEL_AUTHELIA_HOST_ADMIN_ACCESS_AUDIENCE ?? 'pluxel-host-admin-access',
			requiredClaims: { groups: 'pluxel-admins' },
		},
	},
})
