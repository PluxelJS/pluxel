import { resolve } from 'node:path'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { AutheliaOidcDemoPlugin } from './plugin.ts'

const repoRoot = resolve(import.meta.dirname, '../../../..')
const staticDataRoot = resolve(repoRoot, 'packages/plugins/authelia-oidc-demo/.pluxel/static')

export const autheliaOidcDemoPlugins = [AutheliaOidcDemoPlugin] as const
export const autheliaOidcDemoEnabledPlugins = ['AutheliaOidcDemoPlugin'] as const

export default defineStaticRuntimeConfig({
	name: 'plugins-authelia-oidc-demo',
	plugins: autheliaOidcDemoPlugins,
	runtimeState: {
		snapshot: { enabled: autheliaOidcDemoEnabledPlugins },
	},
	logger: { preset: 'core' },
	persistence: resolve(staticDataRoot, 'persistence'),
	workbench: {
		enabled: true,
		access: {
			exposure: 'public',
			oidc: {
				issuer: process.env.PLUXEL_AUTHELIA_ISSUER ?? 'http://127.0.0.1:9091',
				audience:
					process.env.PLUXEL_AUTHELIA_HOST_ADMIN_ACCESS_AUDIENCE ?? 'pluxel-host-admin-access',
				requiredClaims: { groups: 'pluxel-admins' },
			},
		},
	},
})
