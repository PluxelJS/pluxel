import { managementApp } from '@pluxel/runtime/management/ui'
import { ChatSandboxManagement } from '../management-module.ts'
export const sandboxPlugin = managementApp(ChatSandboxManagement)
