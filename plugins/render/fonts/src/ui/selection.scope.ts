import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { FontsWorkbench } from '../workbench.ts'

export const selectionScope = createWorkbenchRenderer(FontsWorkbench.selection)

export const fontSelectionQuery = selectionScope.query({
	queryFn: ({ provider }) => provider.snapshot(),
})

export const setPreferredFontMutation = selectionScope.mutation({
	mutationFn: ({ provider }, family: string | null) => provider.setPreferredFamily(family),
	invalidates: [fontSelectionQuery],
})
