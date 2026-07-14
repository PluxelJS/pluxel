import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { YiqichaWorkbench } from '../workbench-extension.ts'

export const yiqichaUi = createWorkbenchUi<typeof YiqichaWorkbench>()
export const useYiqichaProviderModel = () =>
	yiqichaUi.useModel(({ commands, settings, status }) => ({ commands, settings, status }))
export const useYiqichaHistoryModel = () =>
	yiqichaUi.useModel(({ commands, history }) => ({ commands, history }))
