import { managementApp } from '@pluxel/runtime/management/ui'
import { UsageBillingManagement } from '../management-module.ts'

export const billingPlugin = managementApp(UsageBillingManagement)
