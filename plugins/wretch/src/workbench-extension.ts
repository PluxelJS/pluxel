import { workbench, type WorkbenchExtension } from '@pluxel/runtime/workbench'
import { WretchWorkbenchUi } from './workbench-renderer-contract.ts'

export const WretchWorkbench: WorkbenchExtension<typeof WretchWorkbenchUi> = workbench.extension({
	contract: WretchWorkbenchUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
