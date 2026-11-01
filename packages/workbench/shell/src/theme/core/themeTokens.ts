import type { MantineColorsTuple } from '@mantine/core'
import { createMantinePaletteFromSeed } from './tonalPalette'

export type PlxThemeMode = 'light' | 'dark'

export type PlxNeutralFoundation = {
	bg: string
	bgAlt: string
	surface: string
	surfaceStrong: string
	surfaceMuted: string
	text: string
	textMuted: string
	border: string
	borderStrong: string
}

export type PlxFixedLevels = {
	info: string
	warning: string
	error: string
	fatal: string
}

export type PlxLogSurfaceFoundation = {
	panelBg: string
	panelHeaderBg: string
	listBg: string
	buttonBg: string
	inputBg: string
	trace: string
}

/**
 * Radius scale. Controls, cards, tags and panels share `sm`; menus, popovers and dialogs use `lg`.
 * Shell SCSS references these through `--mantine-radius-*`, never raw pixel values.
 */
export const PLX_RADIUS = {
	xs: '2px',
	sm: '4px',
	md: '4px',
	lg: '6px',
	xl: '6px',
} as const

/** Font-size scale; Shell SCSS references these through `--mantine-font-size-*`. */
export const PLX_FONT_SIZES = {
	xs: '13px',
	sm: '14px',
	md: '15px',
	lg: '17px',
	xl: '22px',
} as const

export const PLX_MANTINE_COLORS = {
	black: '#141414',
	white: '#fbfbfb',
	// Graphite: neutral greys (no hue), so accent and status colours are the only colour on screen.
	dark: [
		'#ececec',
		'#c4c4c4',
		'#a1a1a1',
		'#7a7a7a',
		'#4a4a4a',
		'#383838',
		'#2b2b2b',
		'#222222',
		'#1b1b1b',
		'#141414',
	] as MantineColorsTuple,
}

/**
 * Status and decorative hues (FantasticFrame graphite seeds). Every Mantine colour the Shell or a
 * plugin renderer names resolves to the same low-chroma family, so badges, switches and alerts
 * stay in one register instead of Mantine's saturated defaults.
 */
const PLX_HUE_SEEDS = {
	red: '#e0645c',
	pink: '#d98aa8',
	grape: '#c58fcf',
	violet: '#b393d6',
	indigo: '#7f8fe0',
	blue: '#5aa2ee',
	cyan: '#6cb6c9',
	teal: '#6fb8a8',
	green: '#7cc08a',
	lime: '#a8c26a',
	yellow: '#d9bb62',
	orange: '#e08a4f',
} as const

export const PLX_HUE_PALETTES = Object.fromEntries(
	Object.entries(PLX_HUE_SEEDS).map(([name, seed]) => [name, createMantinePaletteFromSeed(seed)]),
) as Record<keyof typeof PLX_HUE_SEEDS, MantineColorsTuple>

export const PLX_NEUTRAL_FOUNDATIONS: Record<PlxThemeMode, PlxNeutralFoundation> = {
	dark: {
		bg: '#161616',
		bgAlt: '#1b1b1b',
		surface: '#222222',
		surfaceStrong: '#262626',
		surfaceMuted: '#1f1f1f',
		text: '#ececec',
		textMuted: '#a1a1a1',
		border: '#333333',
		borderStrong: '#444444',
	},
	light: {
		bg: '#ececec',
		bgAlt: '#f3f3f3',
		surface: '#ffffff',
		surfaceStrong: '#ffffff',
		surfaceMuted: '#f0f0f0',
		text: '#1f1f1f',
		textMuted: '#666666',
		border: '#dddddd',
		borderStrong: '#cccccc',
	},
}

export const PLX_FIXED_LEVELS: Record<PlxThemeMode, PlxFixedLevels> = {
	dark: {
		info: '#7dbb9a',
		warning: '#d8ac64',
		error: '#e7a59d',
		fatal: '#c1a8ea',
	},
	light: {
		info: '#2f7b63',
		warning: '#a77434',
		error: '#c9584c',
		fatal: '#7557a3',
	},
}

export const PLX_LOG_SURFACES: Record<PlxThemeMode, PlxLogSurfaceFoundation> = {
	dark: {
		panelBg: '#1b1b1b',
		panelHeaderBg: '#222222',
		listBg: '#181818',
		buttonBg: '#262626',
		inputBg: '#161616',
		trace: '#8a8a8a',
	},
	light: {
		panelBg: '#ffffff',
		panelHeaderBg: '#f6f6f6',
		listBg: '#fdfdfd',
		buttonBg: '#f0f0f0',
		inputBg: '#ffffff',
		trace: '#707070',
	},
}

export const PLX_APP_SHADOWS: Record<PlxThemeMode, string> = {
	dark: '0 8px 24px rgba(0, 0, 0, 0.35)',
	light: '0 6px 18px rgba(0, 0, 0, 0.06)',
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
