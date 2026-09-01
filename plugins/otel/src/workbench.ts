import { workbench } from '@pluxel/runtime/workbench'

export const OtelWorkbench = workbench.define({
	operations: workbench.page({
		document: workbench.markdown(import.meta.url, './workbench-guide.md'),
		placement: workbench.tab({
			label: '运维说明',
			icon: workbench.icons.TextRecognition,
			order: 80,
		}),
	}),
})
