import { workbench } from '@pluxel/runtime/workbench'
import type {
	DemoEvent,
	PluginWithUIEvents,
	PluginWithUIRpc,
	PluginWithUIStatusDoc,
} from './PluginWithUI'

export const PluginWithUIWorkbench = workbench.define({
	plugin: 'PluginWithUI',
	entry: workbench.entry(import.meta.url, './PluginWithUI/ui/index.tsx'),
	model: {
		commands: workbench.model.rpc<PluginWithUIRpc>(),
		status: workbench.model.collection<PluginWithUIStatusDoc>(),
		events: workbench.model.collection<DemoEvent>(),
		activity: workbench.model.events<PluginWithUIEvents>(),
	},
	views: (model) => ({
		HeaderAction: workbench.view.remote({
			placements: [
				workbench.place.slot({ slot: workbench.slot.GlobalHeaderActions, priority: 100 }),
			],
		}),
		OverviewPanel: workbench.view.remote({
			model: [model.commands, model.status, model.events, model.activity],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 20,
					label: '概览',
				}),
			],
		}),
		EventsPanel: workbench.view.remote({
			model: [model.commands, model.events],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 19,
					label: '事件',
				}),
			],
		}),
		StreamsPanel: workbench.view.remote({
			model: [model.activity],
			placements: [
				workbench.place.slot({
					slot: workbench.slot.PluginTabs,
					priority: 18,
					label: '实时事件',
				}),
			],
		}),
		PluginInfo: workbench.view.remote({
			placements: [workbench.place.slot({ slot: workbench.slot.PluginInfo, priority: 10 })],
		}),
		RoutePage: workbench.view.remote({
			placements: [
				workbench.place.route({
					path: '/dashboard',
					title: 'PluginWithUI Dashboard',
					navigation: { priority: 50 },
				}),
				workbench.place.route({ path: '/notes', title: 'PluginWithUI Notes' }),
			],
		}),
		StandaloneRoute: workbench.view.remote({
			placements: [
				workbench.place.route({
					path: '/standalone',
					title: 'PluginWithUI Standalone',
					frame: 'standalone',
				}),
			],
		}),
	}),
})
