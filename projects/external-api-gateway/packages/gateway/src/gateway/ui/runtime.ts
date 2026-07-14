import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import type { ExternalGatewayWorkbench } from '../workbench-extension.ts'

export const gatewayUi = createWorkbenchUi<typeof ExternalGatewayWorkbench>()
export const useGatewayModel = () =>
	gatewayUi.useModel(({ commands, tokens, status }) => ({ commands, tokens, status }))
