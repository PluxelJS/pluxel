import { workbench } from '@pluxel/workbench'
import type { FontSelectionApi, FontsManagerApi } from './workbench-contracts.ts'

export type {
	DefaultFontSnapshot,
	FontFamilySnapshot,
	FontSelectionApi,
	FontSelectionSnapshot,
	FontsManagerApi,
	FontsManagerSnapshot,
	FontStyleSnapshot,
	InstallManagedFontInput,
	ManagedFontSnapshot,
} from './workbench-contracts.ts'

/** Fonts owns both renderers and APIs; consumers only place the selection Attachment. */
export const FontsWorkbench = workbench.define(import.meta.url, {
	manager: workbench.view<FontsManagerApi>({
		renderer: './ui/manager.tsx',
		placement: {
			kind: 'tab',
			label: 'Fonts',
			icon: 'typography',
		},
	}),
	selection: workbench.attachment<FontSelectionApi>({
		renderer: './ui/selection.tsx',
	}),
})
