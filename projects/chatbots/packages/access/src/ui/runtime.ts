import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ChatAccessWorkbench } from '../workbench-module.ts'
export const accessPlugin = createWorkbenchUi<typeof ChatAccessWorkbench>()
export const accessViews = accessPlugin.view('AccessPanel', 'AccessRoute')
export type AccessViewModel = ReturnType<typeof accessViews.useModel>
