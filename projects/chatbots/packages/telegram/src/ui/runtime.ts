import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { TelegramWorkbench } from '../workbench-module.ts'

export const telegramPlugin = createWorkbenchUi<typeof TelegramWorkbench>()
