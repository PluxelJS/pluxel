import { workbench } from '@pluxel/runtime/workbench'
import { ZhipuUi } from './workbench-contract.ts'

export const ZhipuWorkbench = workbench.extension({
	contract: ZhipuUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
