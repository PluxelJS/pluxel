import { managementApp } from '@pluxel/runtime/management/ui'
import { ExternalGatewayManagement } from '../management-module.ts'

export const gatewayPlugin = managementApp(ExternalGatewayManagement)
