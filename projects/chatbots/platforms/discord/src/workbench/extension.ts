import { workbench } from '@pluxel/runtime/workbench'
import { DiscordUi } from './contract.ts'

export const DiscordWorkbench = workbench.extension({
	contract: DiscordUi,
	entry: workbench.entry(import.meta.url, './ui.tsx'),
})
