import { managementApp } from '@pluxel/runtime/management/ui'
import type { KookManagementModule } from '../management-module.ts'

export const kookPlugin = managementApp<typeof KookManagementModule>()
