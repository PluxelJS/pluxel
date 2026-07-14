import { managementApp } from '@pluxel/runtime/management/ui'
import type { TelegramManagementModule } from '../management-module.ts'

export const telegramPlugin = managementApp<typeof TelegramManagementModule>()
