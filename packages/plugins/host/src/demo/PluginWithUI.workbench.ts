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
	views: {
		HeaderAction: workbench.view.slot({
			slot: workbench.slot.GlobalHeaderActions,
			model: ['activity'],
			priority: 100,
		}),
		OverviewPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'status', 'events', 'activity'],
			priority: 20,
			label: '概览',
		}),
		EventsPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['commands', 'events'],
			priority: 19,
			label: '事件',
		}),
		StreamsPanel: workbench.view.slot({
			slot: workbench.slot.PluginTabs,
			model: ['activity'],
			priority: 18,
			label: '实时事件',
		}),
		PluginInfo: workbench.view.slot({
			slot: workbench.slot.PluginInfo,
			model: ['status', 'activity'],
			priority: 10,
		}),
		DashboardRoute: workbench.view.route({
			path: '/dashboard',
			title: 'PluginWithUI Dashboard',
			navigation: { priority: 50 },
			model: ['commands', 'status', 'events', 'activity'],
		}),
		NotesRoute: workbench.view.route({
			path: '/notes',
			title: 'PluginWithUI Notes',
			model: ['commands', 'status', 'events', 'activity'],
		}),
		StandaloneRoute: workbench.view.route({
			path: '/standalone',
			title: 'PluginWithUI Standalone',
			frame: 'standalone',
			model: ['status', 'activity'],
		}),
	},
})
