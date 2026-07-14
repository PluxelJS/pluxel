import { managementApp } from '@pluxel/runtime/management/ui'
import type { ExternalGatewayManagement } from '../management-module.ts'

export const gatewayPlugin = managementApp<typeof ExternalGatewayManagement>()
