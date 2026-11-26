import type { RpcTarget } from 'capnweb'
import { workbench } from '@pluxel/workbench'
import type { FontRef, FontSet } from './PluginContributionFontDemo.shared'

export interface FontCatalogApi extends RpcTarget {
	listDto(): readonly FontSet[]
}

export interface FontSelectionApi extends RpcTarget {
	currentDto(): FontRef | null
	set(ref: FontRef | null): void
}

export const FontManagerWorkbench = workbench.define(import.meta.url, {
	selection: workbench.attachment<FontCatalogApi, FontSelectionApi>({
		renderer: './PluginContributionFontDemo/ui/selection.tsx',
	}),
})

export const FontConsumerWorkbench = workbench.define(import.meta.url, {
	appearanceFont: FontManagerWorkbench.selection.place({
		kind: 'tab',
		label: 'Typography',
		icon: 'typography',
		group: {
			id: 'typography',
			label: 'Typography',
			icon: 'typography',
		},
		order: 40,
	}),
})
