import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { ChatAccessUi } from '../workbench-contract.ts'
export const accessUi = createWorkbenchUi(ChatAccessUi)
export type AccessViewModel = ReturnType<typeof accessUi.useResources>
