import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { FontManagerWorkbench } from '../../PluginContributionFontDemo.workbench'
import type { FontRef } from '../../PluginContributionFontDemo.shared'

export const selectionScope = createWorkbenchRenderer(FontManagerWorkbench.selection)

export const fontCatalog = selectionScope.query({
	queryFn: ({ provider }) => provider.list(),
})

export const fontSelection = selectionScope.query({
	queryFn: ({ consumer }) => consumer.current(),
})

export const setFontSelection = selectionScope.mutation({
	mutationFn: ({ consumer }, ref: FontRef | null) => consumer.set(ref),
	invalidates: [fontSelection],
})
