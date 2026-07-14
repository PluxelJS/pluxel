import { managementApp } from '@pluxel/runtime/management/ui'
import type { ChatAccessManagement } from '../management-module.ts'
export const accessPlugin = managementApp<typeof ChatAccessManagement>()
