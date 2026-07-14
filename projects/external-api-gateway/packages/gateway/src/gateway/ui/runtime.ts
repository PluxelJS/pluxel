import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ExternalGatewayWorkbench } from '../workbench-module.ts'

export const gatewayPlugin = createWorkbenchUi<typeof ExternalGatewayWorkbench>()
