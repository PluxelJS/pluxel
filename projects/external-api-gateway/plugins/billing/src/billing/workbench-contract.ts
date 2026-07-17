import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { jsonObjectSchema } from '@repo/external-api-gateway-shared/wire-schema'
import type {
	BillingOverviewDoc,
	BillingProviderSummaryDoc,
	BillingRateDoc,
	BillingUsageRecord,
	BillingUserSummaryDoc,
} from './contracts.ts'
export interface UsageBillingCommands {
	clearUsage(): unknown
	upsertRate(input: Omit<BillingRateDoc, 'id' | 'updatedAt'>): BillingRateDoc
}

export const UsageBillingUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<UsageBillingCommands>(),
		overview: workbenchContract.liveQuery({
			row: jsonObjectSchema<BillingOverviewDoc>(),
			key: 'id',
		}),
		records: workbenchContract.liveQuery({
			row: jsonObjectSchema<BillingUsageRecord>(),
			key: 'id',
		}),
		users: workbenchContract.liveQuery({
			row: jsonObjectSchema<BillingUserSummaryDoc>(),
			key: 'id',
		}),
		providers: workbenchContract.liveQuery({
			row: jsonObjectSchema<BillingProviderSummaryDoc>(),
			key: 'id',
		}),
		rates: workbenchContract.liveQuery({ row: jsonObjectSchema<BillingRateDoc>(), key: 'id' }),
	},
	views: {
		HeaderAction: {
			placements: [workbenchContract.slot(workbenchContract.slots.GlobalHeaderActions)],
		},
		BillingPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 20,
					label: '用量总览',
					icon: workbenchContract.icons.ChartBar,
				}),
			],
		},
		BillingDashboard: {
			placements: [
				workbenchContract.route('/dashboard', {
					title: 'Usage Billing',
					icon: workbenchContract.icons.Receipt,
					order: 90,
				}),
			],
		},
	},
})
