import {
	defaultCssVariablesResolver,
	type CSSVariablesResolver,
	type MantineColorScheme,
	type MantineTheme,
	useComputedColorScheme,
	useMantineTheme,
} from '@mantine/core'
import { useMemo } from 'react'
import { DEFAULT_ACCENT_KEY, getAccentPreset } from '../accent/accentPresets'
import {
	PLX_FIXED_LEVELS,
	PLX_LOG_ANSI16,
	PLX_NEUTRAL_FOUNDATIONS,
	PLX_STATE_INK,
	type PlxNeutralFoundation,
	type PlxThemeMode,
} from './themeTokens'
import { alpha, createMaterialThemeSource, mutedTonalPalette, toneHex } from './tonalPalette'

export type PlxLogTheme = {
	listStripe: string
	rowSelectedBg: string
	levels: Record<string, string>
	ansi16: readonly string[]
}

/** Interaction states shared by tabs, catalog rows and navigation entries. */
export type PlxControlStates = {
	hoverBg: string
	inactiveSelectedBg: string
	selectedBg: string
	selectedBorder: string
}

export type PlxThemeModel = {
	mode: PlxThemeMode
	neutral: PlxNeutralFoundation
	controls: PlxControlStates
	log: PlxLogTheme
}

const DEFAULT_ACCENT_HEX = getAccentPreset(DEFAULT_ACCENT_KEY).color
const themeModelCache = new Map<string, PlxThemeModel>()

function themeSeed(theme?: MantineTheme) {
	return theme?.other.plxAccentHex ?? DEFAULT_ACCENT_HEX
}

function buildThemeModel(seedHex: string, mode: PlxThemeMode): PlxThemeModel {
	const isDark = mode === 'dark'
	const neutral = PLX_NEUTRAL_FOUNDATIONS[mode]
	const ink = PLX_STATE_INK[mode]
	const accent = mutedTonalPalette(seedHex)
	const controls: PlxControlStates = {
		hoverBg: alpha(ink, isDark ? 0.045 : 0.045),
		inactiveSelectedBg: alpha(ink, isDark ? 0.075 : 0.07),
		selectedBg: alpha(toneHex(accent, isDark ? 70 : 52), isDark ? 0.2 : 0.14),
		selectedBorder: alpha(toneHex(accent, isDark ? 74 : 48), isDark ? 0.5 : 0.4),
	}
	const levels = PLX_FIXED_LEVELS[mode]
	const error = toneHex(createMaterialThemeSource(seedHex).core.error, isDark ? 82 : 42)
	return {
		mode,
		neutral,
		controls,
		log: {
			listStripe: alpha(ink, isDark ? 0.024 : 0.018),
			rowSelectedBg: controls.selectedBg,
			levels: {
				trace: levels.trace,
				debug: toneHex(accent, isDark ? 70 : 44),
				info: levels.info,
				warning: levels.warning,
				error,
				fatal: levels.fatal,
				default: neutral.text,
			},
			ansi16: PLX_LOG_ANSI16[mode],
		},
	}
}

export function resolveThemeMode(colorScheme?: MantineColorScheme): PlxThemeMode {
	return colorScheme === 'dark' ? 'dark' : 'light'
}

export function getThemeModel(
	colorScheme?: MantineColorScheme,
	seedHex = DEFAULT_ACCENT_HEX,
): PlxThemeModel {
	const mode = resolveThemeMode(colorScheme)
	const key = `${mode}:${seedHex.toLowerCase()}`
	const cached = themeModelCache.get(key)
	if (cached) return cached
	const next = buildThemeModel(seedHex, mode)
	themeModelCache.set(key, next)
	return next
}

export function useThemeModel() {
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const theme = useMantineTheme()
	const seedHex = themeSeed(theme)
	return useMemo(() => getThemeModel(colorScheme, seedHex), [colorScheme, seedHex])
}

/**
 * Mantine variables carry text, surfaces, borders and accent. `--plx-*` only names what Mantine
 * has no slot for: the chrome canvas, inset surfaces, hairlines and selection states.
 */
function schemeVariables({ mode, neutral, controls }: PlxThemeModel) {
	const ink = PLX_STATE_INK[mode]
	return {
		'--mantine-color-body': neutral.surface,
		'--mantine-color-text': neutral.text,
		'--mantine-color-default': neutral.raised,
		'--mantine-color-default-hover': neutral.raisedHover,
		'--mantine-color-default-color': neutral.text,
		'--mantine-color-default-border': neutral.borderStrong,
		'--mantine-color-dimmed': neutral.textMuted,
		'--mantine-color-placeholder': alpha(neutral.textMuted, 0.88),
		// Disabled controls fade out instead of turning into solid grey blocks.
		'--mantine-color-disabled': alpha(ink, 0.04),
		'--mantine-color-disabled-color': alpha(neutral.textMuted, 0.7),
		'--mantine-color-disabled-border': alpha(ink, 0.06),
		'--plx-canvas': neutral.canvas,
		'--plx-raised': neutral.raised,
		// Same surface Mantine gives Menu and Popover dropdowns (white / dark-6).
		'--plx-overlay': mode === 'dark' ? neutral.raised : neutral.surface,
		'--plx-border': neutral.border,
		'--plx-hover-bg': controls.hoverBg,
		'--plx-selected-bg': controls.selectedBg,
		'--plx-selected-inactive-bg': controls.inactiveSelectedBg,
		'--plx-selected-border': controls.selectedBorder,
	}
}

/**
 * `light` variants as a translucent tint of the hue with a readable label in the same hue.
 * Mantine 9's defaults use the palette's extreme shades (near white on dark, near black on light),
 * which drops the hue entirely with the low-chroma Workbench palettes.
 */
function lightVariantVariables(theme: MantineTheme, mode: PlxThemeMode) {
	const variables: Record<string, string> = {}
	for (const [name, shades] of Object.entries(theme.colors)) {
		if (name === 'dark' || !shades) continue
		const tint = mode === 'dark' ? shades[4] : shades[6]
		variables[`--mantine-color-${name}-light`] = alpha(tint, mode === 'dark' ? 0.14 : 0.1)
		variables[`--mantine-color-${name}-light-hover`] = alpha(tint, mode === 'dark' ? 0.2 : 0.15)
		variables[`--mantine-color-${name}-light-color`] = mode === 'dark' ? shades[4] : shades[7]
	}
	return variables
}

/** Dark surfaces need deeper, denser shadows for floating layers to separate from the canvas. */
const DARK_ELEVATION = {
	'--mantine-shadow-xs': '0 1px 2px rgba(0, 0, 0, 0.32)',
	'--mantine-shadow-sm': '0 1px 3px rgba(0, 0, 0, 0.4), 0 1px 2px rgba(0, 0, 0, 0.28)',
	'--mantine-shadow-md': '0 10px 28px -6px rgba(0, 0, 0, 0.6), 0 2px 8px rgba(0, 0, 0, 0.36)',
	'--mantine-shadow-lg': '0 18px 44px -8px rgba(0, 0, 0, 0.66), 0 4px 14px rgba(0, 0, 0, 0.4)',
	'--mantine-shadow-xl': '0 28px 70px -12px rgba(0, 0, 0, 0.72), 0 8px 22px rgba(0, 0, 0, 0.44)',
	// Tooltips read as a raised dark layer instead of Mantine's inverted light chip.
	'--tooltip-bg': '#2a2c31',
	'--tooltip-color': '#e4e5e9',
}

export const appCssVariablesResolver: CSSVariablesResolver = (theme) => {
	const base = defaultCssVariablesResolver(theme)
	const seedHex = themeSeed(theme)
	return {
		variables: base.variables,
		light: {
			...base.light,
			...lightVariantVariables(theme, 'light'),
			...schemeVariables(getThemeModel('light', seedHex)),
		},
		dark: {
			...base.dark,
			...lightVariantVariables(theme, 'dark'),
			...schemeVariables(getThemeModel('dark', seedHex)),
			...DARK_ELEVATION,
		},
	}
}
