import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import {
	FontSettingsPort,
	type FontSetDoc,
	type FontSettingsCommands,
} from './PluginContributionFontDemo.contract'

export const FontManagerUi = workbenchContract.define({
	resources: { fontSets: workbenchContract.collection<FontSetDoc>() },
	views: {
		FontSettings: {
			accepts: FontSettingsPort,
		},
	},
})

export const FontConsumerUi = workbenchContract.define({
	resources: { commands: workbenchContract.rpc<FontSettingsCommands>() },
	views: {},
	outlets: ({ resources }) => ({
		AppearanceFont: {
			placement: workbenchContract.slot(workbenchContract.slots.PluginTabs, {
				order: 40,
				label: 'Typography',
				icon: workbenchContract.icons.Typography,
				tab: {
					id: 'typography',
					label: 'Typography',
					icon: workbenchContract.icons.Typography,
				},
			}),
			port: FontSettingsPort,
			provide: { settings: resources.commands },
		},
	}),
})
