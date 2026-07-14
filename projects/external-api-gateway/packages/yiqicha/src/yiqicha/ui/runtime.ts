import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { YiqichaUi } from '../workbench-contract.ts'

export const yiqichaUi = createWorkbenchUi(YiqichaUi)
export const useYiqichaProviderModel = () => yiqichaUi.useResources()
export const useYiqichaHistoryModel = () => yiqichaUi.useResources()
