import { resolve } from 'node:path'
import { UsageBillingPlugin } from '@repo/external-api-gateway-billing'
import { ExternalGatewayPlugin } from '@repo/external-api-gateway-gateway'
import { YiqichaProviderPlugin } from '@repo/external-api-gateway-yiqicha'
import { ZhipuProviderPlugin } from '@repo/external-api-gateway-zhipu'
import { defineStaticRuntime } from '@pluxel/runtime-static'
import { prepareExternalGatewayRuntime } from './runtime-bootstrap'

export const externalApiGatewayPlugins = [
	UsageBillingPlugin,
	ZhipuProviderPlugin,
	YiqichaProviderPlugin,
	ExternalGatewayPlugin,
] as const
export const externalApiGatewayEnabledPlugins = [
	'UsageBillingPlugin',
	'ZhipuProviderPlugin',
	'YiqichaProviderPlugin',
	'ExternalGatewayPlugin',
] as const

export default defineStaticRuntime({
	name: 'external-api-gateway',
	plugins: externalApiGatewayPlugins,
	configure({ env, deployment }) {
		const projectRoot = resolve(import.meta.dirname, '..')
		const staticDataRoot = env.PLUXEL_STATIC_DATA_ROOT
			? resolve(env.PLUXEL_STATIC_DATA_ROOT)
			: resolve(deployment?.root ?? projectRoot, '.pluxel/static')
		return {
			runtimeState: {
				snapshot: { enabled: externalApiGatewayEnabledPlugins },
			},
			persistence: resolve(staticDataRoot, 'persistence'),
			workbench:
				env.PLUXEL_WORKBENCH === 'false'
					? false
					: { enabled: true, access: { exposure: 'private' } },
		}
	},
	prepare: ({ host }) => prepareExternalGatewayRuntime(host.ctx),
})
