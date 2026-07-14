import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ChatSandboxWorkbench } from '../workbench-extension.ts'
export const sandboxUi = createWorkbenchUi<typeof ChatSandboxWorkbench>()
