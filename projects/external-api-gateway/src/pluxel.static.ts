import { resolve } from 'node:path'
import { UsageBillingPlugin } from '@repo/external-api-gateway-billing'
import { ExternalGatewayPlugin } from '@repo/external-api-gateway-gateway'
import { YiqichaProviderPlugin } from '@repo/external-api-gateway-yiqicha'
import { ZhipuProviderPlugin } from '@repo/external-api-gateway-zhipu'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'

const projectRoot = resolve(import.meta.dirname, '..')
const staticDataRoot = resolve(projectRoot, '.pluxel/static')

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

export default defineStaticRuntimeConfig({
	name: 'external-api-gateway',
	plugins: externalApiGatewayPlugins,
	runtimeState: {
		snapshot: { enabled: externalApiGatewayEnabledPlugins },
	},
	persistence: resolve(staticDataRoot, 'persistence'),
	logger: { preset: 'core' },
	management: { enabled: true, access: { exposure: 'private' } },
})
