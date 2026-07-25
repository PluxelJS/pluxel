import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { jsonObjectSchema } from '@repo/external-api-gateway-shared/wire-schema'
import type {
	GatewayStatusDoc,
	GatewayTokenCreateInput,
	GatewayTokenDoc,
} from '@repo/external-api-gateway-shared/gateway'

export interface GatewayAdminCommands {
	createToken(input: GatewayTokenCreateInput): Promise<GatewayTokenDoc>
	revokeToken(id: string): Promise<{ ok: true }>
}

export const ExternalGatewayUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<GatewayAdminCommands>(),
		tokens: workbenchContract.liveQuery({ row: jsonObjectSchema<GatewayTokenDoc>(), key: 'id' }),
		status: workbenchContract.liveQuery({ row: jsonObjectSchema<GatewayStatusDoc>(), key: 'id' }),
	},
	views: {
		GatewayPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 30,
					label: '外部访问',
					icon: workbenchContract.icons.ShieldLock,
				}),
			],
		},
		GatewayDashboard: {
			placements: [
				workbenchContract.route('/dashboard', {
					title: 'External Gateway RPC',
					icon: workbenchContract.icons.Api,
					order: 100,
				}),
			],
		},
	},
})
