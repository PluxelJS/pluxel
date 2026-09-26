import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { FontManagerWorkbench } from '../../PluginContributionFontDemo.workbench'
import type { FontRef } from '../../PluginContributionFontDemo.shared'

export const selectionScope = createWorkbenchRenderer(FontManagerWorkbench.selection)

export const fontCatalog = selectionScope.query(({ provider }) => ({
	queryKey: ['font-contribution', 'catalog'] as const,
	queryFn: () => provider.listDto(),
}))

export const fontSelection = selectionScope.query(({ consumer }) => ({
	queryKey: ['font-contribution', 'selection'] as const,
	queryFn: () => consumer.currentDto(),
}))

export const setFontSelection = selectionScope.mutation(({ consumer }) => ({
	mutationFn: (ref: FontRef | null) => consumer.set(ref),
	workbench: {
		invalidates: [fontSelection],
	},
}))
