import { workbench } from '@pluxel/runtime/workbench'
import { TelegramUi } from './workbench-contract.ts'

export const TelegramWorkbench = workbench.extension({
	contract: TelegramUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})
