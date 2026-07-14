import { workbench } from '@pluxel/runtime/workbench'
import { UsageBillingUi } from './workbench-contract.ts'

export const UsageBillingWorkbench = workbench.extension({
	contract: UsageBillingUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
