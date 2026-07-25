import { workbench } from '@pluxel/runtime/workbench'
import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import { WretchWorkbenchPort } from '@pluxel/wretch/workbench'
import { KookUi } from './contract.ts'

export const KookWorkbench = workbench.extension({
	contract: KookUi,
	entry: workbench.entry(import.meta.url, './ui/index.tsx'),
})

export const KookHttpWorkbench = workbench.portOutlet({
	id: 'Http',
	port: WretchWorkbenchPort,
	placement: workbenchContract.slot(workbenchContract.slots.PluginTabs, {
		order: 49,
		label: 'HTTP',
		icon: workbenchContract.icons.Settings,
	}),
})
