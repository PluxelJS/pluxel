import { workbenchContract } from '@pluxel/runtime/workbench/contract'
import {
	FontSettingsPort,
	type FontSetDoc,
	type FontSettingsCommands,
} from './PluginContributionFontDemo.contract'
import { jsonObjectSchema } from './wire-schema'

export const FontManagerUi = workbenchContract.define({
	resources: {
		fontSets: workbenchContract.liveQuery({ row: jsonObjectSchema<FontSetDoc>(), key: 'id' }),
	},
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
			placement: workbenchContract.tab({
				order: 40,
				label: 'Typography',
				icon: workbenchContract.icons.Typography,
				group: {
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
