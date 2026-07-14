import { workbench } from '@pluxel/runtime/workbench'
import type {
	BillingOverviewDoc,
	BillingProviderSummaryDoc,
	BillingRateDoc,
	BillingUsageRecord,
	BillingUserSummaryDoc,
} from './contracts.ts'
import type { UsageBillingRpc } from './plugin.ts'

export const UsageBillingWorkbench = workbench.define({
	plugin: 'UsageBillingPlugin',
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<UsageBillingRpc>(),
		overview: workbench.model.collection<BillingOverviewDoc>(),
		records: workbench.model.collection<BillingUsageRecord>(),
		users: workbench.model.collection<BillingUserSummaryDoc>(),
		providers: workbench.model.collection<BillingProviderSummaryDoc>(),
		rates: workbench.model.collection<BillingRateDoc>(),
	},
	views: (model) => ({
		HeaderAction: workbench.view.remote({
			model: [model.overview],
			placements: [
				workbench.place.slot({ slot: workbench.slot.GlobalHeaderActions, priority: 100 }),
			],
		}),
		BillingPanel: workbench.view.remote({
			model: [
				model.commands,
				model.overview,
				model.records,
				model.users,
				model.providers,
				model.rates,
			],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 20,
					label: '用量总览',
					icon: 'chart-bar',
				}),
			],
		}),
		BillingDashboard: workbench.view.remote({
			model: [
				model.commands,
				model.overview,
				model.records,
				model.users,
				model.providers,
				model.rates,
			],
			placements: [
				workbench.place.route({
					path: '/dashboard',
					title: 'Usage Billing',
					icon: 'receipt',
					navigation: { priority: 90 },
				}),
			],
		}),
	}),
})
