import { managementApp } from '@pluxel/runtime/management/ui'
import type { UsageBillingManagement } from '../management-module.ts'

export const billingPlugin = managementApp<typeof UsageBillingManagement>()
