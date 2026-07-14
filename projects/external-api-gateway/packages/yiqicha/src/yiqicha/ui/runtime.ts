import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { YiqichaWorkbench } from '../workbench-module.ts'

export const yiqichaPlugin = createWorkbenchUi<typeof YiqichaWorkbench>()
