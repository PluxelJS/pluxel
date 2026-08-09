import { workbenchContract } from '@pluxel/runtime/workbench/contract'

export type FontStyleSnapshot = Readonly<{
	weight: number
	width: string
	style: string
}>

export type FontFamilySnapshot = Readonly<{
	family: string
	source: 'system' | 'registered'
	styles: readonly FontStyleSnapshot[]
}>

export type DefaultFontSnapshot = Readonly<{
	/** Family currently resolved for new renderer resources. */
	family: string
	/** CSS-safe family token or quoted family string. */
	cssFamily: string
	/** Selection layer that produced `family`, not the kind of font resource. */
	source: 'workbench' | 'config' | 'system' | 'generic'
	/** Persisted Workbench preference. It may be temporarily unavailable. */
	workbenchFamily?: string
	/** Host-configured preference used after resetting the Workbench override. */
	configuredFamily?: string
}>

export type FontSelectionSnapshot = Readonly<{
	defaultFont: DefaultFontSnapshot
	families: readonly FontFamilySnapshot[]
}>

export interface FontSelectionCommands {
	/** Reads a detached snapshot; modifying it does not update FontsPlugin. */
	snapshot(): Promise<FontSelectionSnapshot>
	/** Sets the FontsPlugin provider-wide default; `null` restores config/automatic selection. */
	setDefaultFamily(family: string | null): Promise<FontSelectionSnapshot>
}

export const FontsSelectionPort = workbenchContract.port({
	id: '@pluxel/fonts.selection',
	version: 1,
	resources: {
		selection: workbenchContract.rpc<FontSelectionCommands>(),
	},
})
