import { resolve } from 'node:path'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { AutheliaOidcDemoPlugin } from './plugin.ts'

export const autheliaOidcDemoPlugins = [AutheliaOidcDemoPlugin] as const
export const autheliaOidcDemoEnabledPlugins = ['AutheliaOidcDemoPlugin'] as const

export default defineStaticRuntime({
	name: 'plugins-authelia-oidc-demo',
	plugins: autheliaOidcDemoPlugins,
	configure({ env, deployment }) {
		const staticDataRoot = env.PLUXEL_STATIC_DATA_ROOT
			? resolve(env.PLUXEL_STATIC_DATA_ROOT)
			: resolve(deployment?.root ?? resolve(import.meta.dirname, '..'), '.pluxel/static')
		return {
			runtimeState: {
				snapshot: { enabled: autheliaOidcDemoEnabledPlugins },
			},
			persistence: resolve(staticDataRoot, 'persistence'),
			workbench: {
				enabled: true,
				access: {
					exposure: 'public',
					oidc: {
						issuer: env.PLUXEL_AUTHELIA_ISSUER ?? 'http://127.0.0.1:9091',
						audience: env.PLUXEL_AUTHELIA_HOST_ADMIN_ACCESS_AUDIENCE ?? 'pluxel-host-admin-access',
						requiredClaims: { groups: 'pluxel-admins' },
					},
				},
			},
		}
	},
})
