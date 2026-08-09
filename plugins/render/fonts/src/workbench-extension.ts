import { workbench, type WorkbenchExtension } from '@pluxel/runtime/workbench'
import { FontsWorkbenchUi } from './workbench-renderer-contract.ts'

export const FontsWorkbench: WorkbenchExtension<typeof FontsWorkbenchUi> = workbench.extension({
	contract: FontsWorkbenchUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
