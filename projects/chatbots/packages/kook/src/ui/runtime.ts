import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { KookWorkbench } from '../workbench-extension.ts'

export const kookUi = createWorkbenchUi<typeof KookWorkbench>()
