import { createWorkbenchRenderer } from '@pluxel/runtime/workbench/react'
import { FontsWorkbench } from '../workbench.ts'

export const selectionScope = createWorkbenchRenderer(FontsWorkbench.selection)

export const fontSelectionQuery = selectionScope.query(({ provider }) => ({
	queryKey: ['fonts', 'selection'] as const,
	queryFn: () => provider.snapshot(),
}))

export const setPreferredFontMutation = selectionScope.mutation(({ provider }) => ({
	mutationFn: (family: string | null) => provider.setPreferredFamily(family),
	workbench: {
		invalidates: [fontSelectionQuery],
	},
}))
