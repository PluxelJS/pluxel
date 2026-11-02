export type PlxThemeMode = 'light' | 'dark'

/**
 * Linear-style neutral layers. Chrome sits on `canvas`; documents float on `surface`
 * (`--mantine-color-body`); `raised` marks inset summaries inside a document.
 */
export type PlxNeutralFoundation = {
	canvas: string
	surface: string
	raised: string
	raisedHover: string
	text: string
	textMuted: string
	/** Hairline between areas and around the document panel. */
	border: string
	/** Control and card outline (`--mantine-color-default-border`). */
	borderStrong: string
}

export const PLX_NEUTRAL_FOUNDATIONS: Record<PlxThemeMode, PlxNeutralFoundation> = {
	dark: {
		canvas: '#0e0f11',
		surface: '#151619',
		raised: '#1b1c20',
		raisedHover: '#222327',
		text: '#e4e5e9',
		textMuted: '#8b909a',
		border: '#222327',
		borderStrong: '#2e3035',
	},
	light: {
		canvas: '#f1f2f4',
		surface: '#ffffff',
		raised: '#f7f8f9',
		raisedHover: '#eef0f2',
		text: '#1b1e24',
		textMuted: '#646a75',
		border: '#e4e6e9',
		borderStrong: '#d6d9de',
	},
}

/** State overlays are translucent so they read the same on canvas and on surface. */
export const PLX_STATE_INK: Record<PlxThemeMode, string> = {
	dark: '#ffffff',
	light: '#141923',
}

export type PlxFixedLevels = {
	trace: string
	info: string
	warning: string
	fatal: string
}

export const PLX_FIXED_LEVELS: Record<PlxThemeMode, PlxFixedLevels> = {
	dark: {
		trace: '#666b74',
		info: '#7dbb9a',
		warning: '#d8ac64',
		fatal: '#c1a8ea',
	},
	light: {
		trace: '#8b909a',
		info: '#2f7b63',
		warning: '#a77434',
		fatal: '#7557a3',
	},
}

export const PLX_LOG_ANSI16: Record<PlxThemeMode, readonly string[]> = {
	dark: [
		'#13181a',
		'#e7a59d',
		'#7dbb9a',
		'#d8ac64',
		'#9abca8',
		'#c1a8ea',
		'#8cc0be',
		'#dfe6e2',
		'#78847f',
		'#f2b6b1',
		'#96ccb0',
		'#e5ba74',
		'#adccb7',
		'#cebaf1',
		'#a1cfca',
		'#f7faf8',
	] as const,
	light: [
		'#18201d',
		'#c9584c',
		'#2f7b63',
		'#a77434',
		'#5e7f6d',
		'#7557a3',
		'#4e8e8c',
		'#e6eeea',
		'#7d8a84',
		'#dc6f63',
		'#42967a',
		'#bf8945',
		'#769686',
		'#8d72b9',
		'#61a8a4',
		'#f9fcfa',
	] as const,
}
