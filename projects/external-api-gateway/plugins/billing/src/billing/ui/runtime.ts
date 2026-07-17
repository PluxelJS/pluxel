import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { UsageBillingUi } from '../workbench-contract.ts'

export const billingUi = createWorkbenchUi(UsageBillingUi)
export const useBillingModel = () => billingUi.useResources()
