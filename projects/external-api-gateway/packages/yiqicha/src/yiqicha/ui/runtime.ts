import { managementApp } from '@pluxel/runtime/management/ui'
import type { YiqichaManagement } from '../management-module.ts'

export const yiqichaPlugin = managementApp<typeof YiqichaManagement>()
