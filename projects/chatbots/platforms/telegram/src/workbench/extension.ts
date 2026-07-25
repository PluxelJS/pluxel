import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { WretchWorkbenchPort } from '@pluxel/wretch/workbench'
import { TelegramUi } from './contract.ts'

export const TelegramWorkbench = workbench.extension({
	contract: TelegramUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

export const TelegramHttpWorkbench = workbench.portOutlet({
	id: 'Http',
	port: WretchWorkbenchPort,
	placement: workbenchContract.tab({
		order: 49,
		label: 'HTTP',
		icon: workbenchContract.icons.Settings,
	}),
})
