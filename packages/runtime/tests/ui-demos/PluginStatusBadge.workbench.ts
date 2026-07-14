import { workbench } from '@pluxel/runtime/workbench'

export const PluginStatusBadgeWorkbench = workbench.define({
	plugin: 'PluginStatusBadge',
	entry: workbench.entry(import.meta.url, './PluginStatusBadge/ui/StatusBadge.tsx'),
	model: {
		activity: workbench.model.events<{ tick: { now: number } }>(),
	},
	views: (model) => ({
		StatusBadge: workbench.view.remote({
			model: [model.activity],
			placements: [
				workbench.place.slot({ slot: workbench.slot.GlobalHeaderActions, priority: 50 }),
			],
		}),
	}),
})
