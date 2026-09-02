import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'
import type { FontRef, FontSet } from './PluginContributionFontDemo.shared'

export interface FontCatalogApi extends RpcTarget {
	list(): readonly FontSet[]
}

export interface FontSelectionApi extends RpcTarget {
	current(): FontRef | null
	set(ref: FontRef | null): void
}

const selectionRenderer = workbench.entry(
	import.meta.url,
	'./PluginContributionFontDemo/ui/index.tsx',
)

export const FontManagerWorkbench = workbench.define({
	selection: workbench.attachment<FontCatalogApi, FontSelectionApi>({
		renderer: selectionRenderer,
	}),
})

export const FontConsumerWorkbench = workbench.define({
	appearanceFont: FontManagerWorkbench.selection.place(
		workbench.tab({
			label: 'Typography',
			icon: workbench.icons.Typography,
			group: {
				id: 'typography',
				label: 'Typography',
				icon: workbench.icons.Typography,
			},
			order: 40,
		}),
	),
})
