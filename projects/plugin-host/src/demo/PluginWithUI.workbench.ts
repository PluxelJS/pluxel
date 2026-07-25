import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import type {
	DemoEvent,
	PluginWithUICommands,
	PluginWithUIEvents,
	PluginWithUIStatusDoc,
} from './PluginWithUI.contracts'
import { jsonObjectSchema } from './wire-schema'

export const PluginWithUIUi = workbenchContract.define({
	resources: {
		commands: workbenchContract.rpc<PluginWithUICommands>(),
		status: workbenchContract.liveQuery({
			row: jsonObjectSchema<PluginWithUIStatusDoc>(),
			key: 'id',
		}),
		events: workbenchContract.liveQuery({ row: jsonObjectSchema<DemoEvent>(), key: 'id' }),
		activity: workbenchContract.events<PluginWithUIEvents>(),
	},
	views: {
		OverviewPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 20,
					label: '概览',
				}),
			],
		},
		EventsPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 19,
					label: '事件',
				}),
			],
		},
		StreamsPanel: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 18,
					label: '实时事件',
				}),
			],
		},
		PluginInfo: {
			placements: [
				workbenchContract.slot(workbenchContract.slots.PluginTabs, {
					order: 10,
					label: '信息',
				}),
			],
		},
		RoutePage: {
			placements: [
				workbenchContract.route('/dashboard', {
					title: 'PluginWithUI Dashboard',
					order: 50,
				}),
				workbenchContract.route('/notes', { title: 'PluginWithUI Notes' }),
			],
		},
		StandaloneRoute: {
			placements: [
				workbenchContract.route('/standalone', {
					title: 'PluginWithUI Standalone',
					frame: 'standalone',
				}),
			],
		},
	},
})
