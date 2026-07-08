import { resolve } from 'node:path'
import { UsageBillingPlugin } from '@repo/external-api-gateway-billing'
import { ExternalGatewayPlugin } from '@repo/external-api-gateway-gateway'
import { YiqichaProviderPlugin } from '@repo/external-api-gateway-yiqicha'
import { ZhipuProviderPlugin } from '@repo/external-api-gateway-zhipu'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'

const projectRoot = resolve(import.meta.dirname, '..')
const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'external-api-gateway'

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
	profile: activeProfile,
	plugins: externalApiGatewayPlugins,
	configService: {
		mode: 'memory',
	},
	runtimeState: {
		mode: 'memory',
		snapshot: { enabled: externalApiGatewayEnabledPlugins },
	},
	logger: { preset: 'core' },
	pluginData: {
		dir: resolve(projectRoot, '.pluxel/static/plugin-data'),
	},
	management: { enabled: true, access: { exposure: 'private' } },
})
