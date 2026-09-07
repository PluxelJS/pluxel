import { FontsWorkbench } from '@pluxel/fonts/workbench'
import { workbench } from '@pluxel/runtime/workbench'

export const TakumiWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(
		workbench.tab({
			label: 'Fonts',
			icon: workbench.icons.Typography,
			order: 30,
		}),
	),
})
