import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ChatAccessWorkbench } from '../workbench-extension.ts'
export const accessUi = createWorkbenchUi<typeof ChatAccessWorkbench>()
export type AccessViewModel = ReturnType<typeof accessUi.views.Access.useModel>
