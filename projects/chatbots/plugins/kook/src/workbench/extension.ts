import { workbench } from '@pluxel/runtime/workbench'
import { KookUi } from './contract.ts'

export const KookWorkbench = workbench.extension({
	contract: KookUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
