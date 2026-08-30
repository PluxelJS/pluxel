import type { RpcTarget } from '@pluxel/runtime/capnweb'
import { workbench } from '@pluxel/runtime/workbench'

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
	source: 'preference' | 'config' | 'system' | 'generic'
	/** Persisted provider-wide preference. It may be temporarily unavailable. */
	preferredFamily?: string
	/** Host-configured preference used after clearing the managed preference. */
	configuredFamily?: string
}>

export type FontSelectionSnapshot = Readonly<{
	defaultFont: DefaultFontSnapshot
	families: readonly FontFamilySnapshot[]
}>

export type ManagedFontSnapshot = Readonly<{
	id: string
	fileName: string
	/** Requested family alias. Omitted when the font's embedded family metadata is used. */
	family?: string
	resolvedFamilies: readonly string[]
	byteLength: number
	installedAt: string
}>

export type FontsManagerSnapshot = Readonly<{
	defaultFont: DefaultFontSnapshot
	managedFonts: readonly ManagedFontSnapshot[]
	families: readonly FontFamilySnapshot[]
	limits: Readonly<{
		maxFonts: number
		maxFontBytes: number
	}>
}>

export type InstallManagedFontInput = Readonly<{
	fileName: string
	/** Optional CSS family alias; omission preserves the font's embedded family metadata. */
	family?: string
	/** Font bytes are copied before registration and persistence. */
	data: Uint8Array
}>

export interface FontsManagerApi extends RpcTarget {
	/** Reads a detached snapshot; modifying it does not update FontsPlugin. */
	snapshot(): Promise<FontsManagerSnapshot>
	/** Sets the provider-wide preference. `null` restores config/automatic selection. */
	setPreferredFamily(family: string | null): Promise<FontsManagerSnapshot>
	install(input: InstallManagedFontInput): Promise<FontsManagerSnapshot>
	remove(id: string): Promise<FontsManagerSnapshot>
}

export interface FontSelectionApi extends RpcTarget {
	/** Reads the provider-owned catalog and current provider-wide selection. */
	snapshot(): Promise<FontSelectionSnapshot>
	/** Sets the provider-wide preference. `null` restores config/automatic selection. */
	setPreferredFamily(family: string | null): Promise<FontSelectionSnapshot>
}

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
