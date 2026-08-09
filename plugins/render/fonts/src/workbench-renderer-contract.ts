import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type { FontsWorkbenchCommands } from './manager-contract.ts'
import { FontsSelectionPort } from './workbench-contract.ts'

export const FontsWorkbenchUi = workbenchContract.define({
	resources: {
		fonts: workbenchContract.rpc<FontsWorkbenchCommands>(),
	},
	views: {
		Fonts: {
			placements: [
				workbenchContract.tab({
					label: 'Fonts',
					icon: workbenchContract.icons.Typography,
				}),
			],
		},
		FontSelection: { accepts: FontsSelectionPort },
	},
})
