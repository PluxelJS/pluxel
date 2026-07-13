import { managementApp } from '@pluxel/runtime/management/ui'
import { TelegramManagementModule } from '../management-module.ts'

export const telegramPlugin = managementApp(TelegramManagementModule)
