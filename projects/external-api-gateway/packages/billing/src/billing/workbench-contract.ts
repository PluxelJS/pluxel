import { workbenchContract } from '@pluxel/runtime/workbench/contract'
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
		overview: workbenchContract.collection<BillingOverviewDoc>(),
		records: workbenchContract.collection<BillingUsageRecord>(),
		users: workbenchContract.collection<BillingUserSummaryDoc>(),
		providers: workbenchContract.collection<BillingProviderSummaryDoc>(),
		rates: workbenchContract.collection<BillingRateDoc>(),
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
