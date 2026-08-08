import type { DefaultFontSnapshot, FontFamilySnapshot } from './workbench-contract.ts'

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

export interface FontsWorkbenchCommands {
	/** Reads a detached snapshot; modifying it does not update FontsPlugin. */
	snapshot(): Promise<FontsManagerSnapshot>
	/** Sets a provider-wide default. `null` restores config/automatic selection. */
	setDefaultFamily(family: string | null): Promise<FontsManagerSnapshot>
	install(input: InstallManagedFontInput): Promise<FontsManagerSnapshot>
	remove(id: string): Promise<FontsManagerSnapshot>
}
