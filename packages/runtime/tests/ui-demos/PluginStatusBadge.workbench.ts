import { workbenchContract } from '@pluxel/runtime/workbench/contract'

export const PluginStatusBadgeUi = workbenchContract.define({
	resources: {
		activity: workbenchContract.events<{ tick: { now: number } }>(),
	},
	views: {
		StatusBadge: {
			placements: [
				workbenchContract.tab({
					order: 50,
					label: '状态',
				}),
			],
		},
	},
})
