import { managementApp } from '@pluxel/runtime/management/ui'
import type { ChatSandboxManagement } from '../management-module.ts'
export const sandboxPlugin = managementApp<typeof ChatSandboxManagement>()
