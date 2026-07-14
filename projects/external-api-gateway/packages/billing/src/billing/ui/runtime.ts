import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { UsageBillingWorkbench } from '../workbench-module.ts'

export const billingPlugin = createWorkbenchUi<typeof UsageBillingWorkbench>()
