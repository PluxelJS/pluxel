import { FontsWorkbench } from '@pluxel/plugin-fonts/workbench'
import { workbench } from '@pluxel/workbench'

export const CanvasWorkbench = workbench.define({
	fonts: FontsWorkbench.selection.place(
		workbench.tab({
			label: 'Fonts',
			icon: workbench.icons.Typography,
			order: 30,
		}),
	),
})
