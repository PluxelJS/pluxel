import { managementApp } from '@pluxel/runtime/management/ui'
import { KookManagementModule } from '../management-module.ts'

export const kookPlugin = managementApp(KookManagementModule)
