import {
	defineManagementModule,
	ManagementPlacements,
	managementPort,
	managementPortRenderer,
	managementResource,
	managementUi,
	remoteView,
} from '@pluxel/runtime/management'
import type { FontSettingsRpc } from './PluginContributionFontDemo'
import {
	FONT_MANAGER_PLUGIN_NAME,
	FontSettingsPort,
	type FontSetDoc,
} from './PluginContributionFontDemo.shared'

export const FontManagerManagement = defineManagementModule({
	id: FONT_MANAGER_PLUGIN_NAME,
	ui: managementUi(import.meta.url, './PluginContributionFontDemo/ui/index.tsx'),
	resources: { fontSets: managementResource.collection<FontSetDoc>() },
	contributions: [
		managementPortRenderer({
			id: 'font-settings-renderer',
			port: FontSettingsPort,
			view: remoteView('FontSettings'),
			priority: 40,
			requireRunning: true,
		}),
	],
})

export const FontConsumerManagement = defineManagementModule({
	id: 'PluginContributionFontConsumer',
	resources: { settings: managementResource.api<FontSettingsRpc>() },
	contributions: [
		managementPort({
			id: 'appearance-font',
			placement: ManagementPlacements.PluginTabs,
			port: FontSettingsPort,
			providers: [FONT_MANAGER_PLUGIN_NAME],
			bindings: { settings: 'settings' },
			priority: 40,
			meta: {
				label: 'Typography',
				icon: 'typography',
				tab: { id: 'typography', label: 'Typography', icon: 'typography' },
			},
		}),
	],
})
