import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ChatSandboxWorkbench } from '../workbench-module.ts'
export const sandboxPlugin = createWorkbenchUi<typeof ChatSandboxWorkbench>()
