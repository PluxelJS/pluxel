import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ZhipuWorkbench } from '../workbench-extension.ts'

export const zhipuUi = createWorkbenchUi<typeof ZhipuWorkbench>()
export const useZhipuProviderModel = () =>
	zhipuUi.useModel(({ commands, settings, status }) => ({ commands, settings, status }))
export const useZhipuHistoryModel = () =>
	zhipuUi.useModel(({ commands, history }) => ({ commands, history }))
