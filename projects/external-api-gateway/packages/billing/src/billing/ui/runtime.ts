import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { UsageBillingWorkbench } from '../workbench-extension.ts'

export const billingUi = createWorkbenchUi<typeof UsageBillingWorkbench>()
export const useBillingModel = () =>
	billingUi.useModel(({ commands, overview, records, users, providers, rates }) => ({
		commands,
		overview,
		records,
		users,
		providers,
		rates,
	}))
