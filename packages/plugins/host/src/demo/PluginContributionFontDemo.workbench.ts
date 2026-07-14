import {
	workbench,
	type WorkbenchCollectionModel,
	type WorkbenchExtension,
	type WorkbenchRpcModel,
	type WorkbenchViewSpec,
} from '@pluxel/runtime/workbench'
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
	ports: [
		workbench.port.renderer({
			id: 'font-settings-renderer',
			port: FontSettingsPort,
			export: 'FontSettings',
			model: ['fontSets'],
			priority: 40,
			when: 'running',
		}),
	],
})

export const FontConsumerWorkbench = workbench.define({
	plugin: 'PluginContributionFontConsumer',
	model: { commands: workbench.model.rpc<FontSettingsRpc>() },
	ports: [
		workbench.port.outlet({
			id: 'appearance-font',
			placement: workbench.slot.PluginTabs,
			port: FontSettingsPort,
			providers: [FONT_MANAGER_PLUGIN_NAME],
			provide: { settings: 'commands' },
			priority: 40,
			meta: {
				label: 'Typography',
				icon: 'typography',
				tab: { id: 'typography', label: 'Typography', icon: 'typography' },
			},
		}),
	],
})

export type FontSettingsWorkbenchView = WorkbenchExtension<
	{
		fontSets: WorkbenchCollectionModel<FontSetDoc>
		settings: WorkbenchRpcModel<FontSettingsRpc>
	},
	{ FontSettings: WorkbenchViewSpec<'fontSets' | 'settings'> }
>
