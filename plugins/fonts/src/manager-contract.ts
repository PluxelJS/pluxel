import type { DefaultFontSnapshot, FontFamilySnapshot } from './workbench-contract.ts'

export type ManagedFontSnapshot = Readonly<{
	id: string
	fileName: string
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
	family?: string
	data: Uint8Array
}>

export interface FontsWorkbenchCommands {
	snapshot(): Promise<FontsManagerSnapshot>
	/** Sets a provider-wide default. `null` restores config/automatic selection. */
	setDefaultFamily(family: string | null): Promise<FontsManagerSnapshot>
	install(input: InstallManagedFontInput): Promise<FontsManagerSnapshot>
	remove(id: string): Promise<FontsManagerSnapshot>
}
