import { workbench } from '@pluxel/runtime/workbench'
import { ChatSandboxUi } from './workbench-contract.ts'

export const ChatSandboxWorkbench = workbench.extension({
	contract: ChatSandboxUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
