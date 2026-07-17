import { workbench } from '@pluxel/runtime/workbench'
import { ChatAccessUi } from './workbench-contract.ts'

export const ChatAccessWorkbench = workbench.extension({
	contract: ChatAccessUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
