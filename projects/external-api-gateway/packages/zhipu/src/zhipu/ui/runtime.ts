import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ZhipuWorkbench } from '../workbench-module.ts'

export const zhipuPlugin = createWorkbenchUi<typeof ZhipuWorkbench>()
