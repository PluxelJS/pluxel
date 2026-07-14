import { workbench } from '@pluxel/runtime/workbench'

export const PluginStatusBadgeWorkbench = workbench.define({
	plugin: 'PluginStatusBadge',
	entry: workbench.entry(import.meta.url, './PluginStatusBadge/ui/StatusBadge.tsx'),
	model: {
		activity: workbench.model.events<{ tick: { now: number } }>(),
	},
	views: {
		StatusBadge: workbench.view.slot({
			slot: workbench.slot.GlobalHeaderActions,
			model: ['activity'],
			priority: 50,
		}),
	},
})
