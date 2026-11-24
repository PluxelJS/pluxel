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

/** Font management View and reusable selector for the bound FontsPlugin node's shared default family. */
export const FontsWorkbench = workbench.define(import.meta.url, {
	manager: workbench.view<FontsManagerApi>({
		renderer: './ui/manager.tsx',
		placement: {
			kind: 'tab',
			label: 'Fonts',
			icon: 'typography',
		},
	}),
	/** Edits this FontsPlugin node's default family preference, shared by all consumers bound to it. */
	selection: workbench.attachment<FontSelectionApi>({
		renderer: './ui/selection.tsx',
	}),
})
