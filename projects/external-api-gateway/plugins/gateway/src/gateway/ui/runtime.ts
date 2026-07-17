import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { ExternalGatewayUi } from '../workbench-contract.ts'

export const gatewayUi = createWorkbenchUi(ExternalGatewayUi)
export const useGatewayModel = () => gatewayUi.useResources()
