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
	/** Explicit host default, taking priority over the managed preference when available. */
	configuredFamily?: string
}>
