import { FontsWorkbench } from '@pluxel/plugin-fonts/workbench'
import { workbench } from '@pluxel/workbench'

export const EChartsWorkbench = workbench.define(import.meta.url, {
	fonts: FontsWorkbench.selection.place({
		kind: 'tab',
		label: 'Fonts',
		icon: 'typography',
		order: 30,
	}),
})
