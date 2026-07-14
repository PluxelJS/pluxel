import { workbench } from '@pluxel/runtime/workbench'
import {
	FONT_MANAGER_PLUGIN_NAME,
	FontSettingsPort,
	type FontSetDoc,
} from './PluginContributionFontDemo.shared'
import type { FontSettingsRpc } from './PluginContributionFontDemo'

export const FontManagerWorkbench = workbench.define({
	plugin: FONT_MANAGER_PLUGIN_NAME,
	entry: workbench.entry(import.meta.url, './PluginContributionFontDemo/ui/index.tsx'),
	model: { fontSets: workbench.model.collection<FontSetDoc>() },
	views: (model) => ({
		FontSettings: workbench.view.remote({
			model: [model.fontSets],
			accepts: FontSettingsPort,
			placements: [],
		}),
	}),
})

export const FontConsumerWorkbench = workbench.define({
	plugin: 'PluginContributionFontConsumer',
	model: { commands: workbench.model.rpc<FontSettingsRpc>() },
	ports: (model) => ({
		AppearanceFont: workbench.port.outlet({
			placement: workbench.slot.PluginTabs,
			port: FontSettingsPort,
			providers: [FONT_MANAGER_PLUGIN_NAME],
			provide: { settings: model.commands },
			priority: 40,
			meta: {
				label: 'Typography',
				icon: 'typography',
				tab: { id: 'typography', label: 'Typography', icon: 'typography' },
			},
		}),
	}),
})
