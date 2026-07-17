import { workbench } from '@pluxel/runtime/workbench'
import { ExternalGatewayUi } from './workbench-contract.ts'

export const ExternalGatewayWorkbench = workbench.extension({
	contract: ExternalGatewayUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
