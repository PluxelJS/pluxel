import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { KookWorkbench } from '../workbench-module.ts'

export const kookPlugin = createWorkbenchUi<typeof KookWorkbench>()
