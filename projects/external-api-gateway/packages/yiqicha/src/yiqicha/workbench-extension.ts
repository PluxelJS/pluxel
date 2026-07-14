import { workbench } from '@pluxel/runtime/workbench'
import { YiqichaUi } from './workbench-contract.ts'

export const YiqichaWorkbench = workbench.extension({
	contract: YiqichaUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
