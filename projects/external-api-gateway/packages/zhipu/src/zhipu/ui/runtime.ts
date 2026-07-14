import { managementApp } from '@pluxel/runtime/management/ui'
import type { ZhipuManagement } from '../management-module.ts'

export const zhipuPlugin = managementApp<typeof ZhipuManagement>()
