import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { ZhipuUi } from '../workbench-contract.ts'

export const zhipuUi = createWorkbenchUi(ZhipuUi)
export const useZhipuProviderModel = () => zhipuUi.useResources()
export const useZhipuHistoryModel = () => zhipuUi.useResources()
