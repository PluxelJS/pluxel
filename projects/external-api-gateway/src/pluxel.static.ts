import { resolve } from 'node:path'
import { defineStaticRuntimeConfig } from '@pluxel/runtime-static'
import { UsageBillingPlugin } from './billing/plugin.ts'
import { ExternalGatewayPlugin } from './gateway/plugin.ts'
import { ZhipuProviderPlugin } from './zhipu/plugin.ts'

const projectRoot = resolve(import.meta.dirname, '..')
const activeProfile = process.env.PLUXEL_RUNTIME_PROFILE ?? 'external-api-gateway'

export const externalApiGatewayPlugins = [
	UsageBillingPlugin,
	ZhipuProviderPlugin,
	ExternalGatewayPlugin,
] as const
export const externalApiGatewayEnabledPlugins = [
	'UsageBillingPlugin',
	'ZhipuProviderPlugin',
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
