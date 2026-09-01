import { workbench } from '@pluxel/runtime/workbench'
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
export const FontsWorkbench = workbench.define({
	manager: workbench.view<FontsManagerApi>({
		renderer: workbench.entry(import.meta.url, './ui/manager.tsx'),
		placement: workbench.tab({
			label: 'Fonts',
			icon: workbench.icons.Typography,
		}),
	}),
	selection: workbench.attachment<FontSelectionApi>({
		renderer: workbench.entry(import.meta.url, './ui/selection.tsx'),
	}),
})
