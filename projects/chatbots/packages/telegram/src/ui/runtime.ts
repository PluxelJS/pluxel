import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { TelegramWorkbench } from '../workbench-extension.ts'

export const telegramUi = createWorkbenchUi<typeof TelegramWorkbench>()
