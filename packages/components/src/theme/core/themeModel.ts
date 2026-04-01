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
	PLX_APP_SHADOWS,
	PLX_FIXED_LEVELS,
	PLX_LOG_ANSI16,
	PLX_LOG_SURFACES,
	PLX_NEUTRAL_FOUNDATIONS,
	type PlxThemeMode,
} from './themeTokens'
import { alpha, createMaterialThemeSource, mix, toneHex } from './tonalPalette'

export type PlxResolvedThemeMode = PlxThemeMode

export type PlxLogTheme = {
	panelBg: string
	panelHeaderBg: string
	listBg: string
	listStripe: string
	border: string
	borderColor: string
	text: string
	textMuted: string
	category: string
	buttonBg: string
	buttonBgAccent: string
	buttonText: string
	inputBg: string
	inputText: string
	rowSelectedBg: string
	errorText: string
	levels: Record<string, string>
	ansi16: readonly string[]
}

export type PlxThemeModel = {
	mode: PlxResolvedThemeMode
	app: {
		bg: string
		bgAlt: string
		surface: string
		surfaceStrong: string
		surfaceMuted: string
		border: string
		borderStrong: string
		text: string
		textMuted: string
		accent: string
		accentStrong: string
		accentSoft: string
		shadow: string
	}
	controls: {
		selectedBg: string
		selectedBorder: string
	}
	workbench: {
		shellBg: string
		shellBgAlt: string
		activityBg: string
		activityItemActive: string
		topbarBg: string
		tabbarBg: string
		surfaceCanvas: string
	}
	log: PlxLogTheme
}

const DEFAULT_ACCENT_HEX = getAccentPreset(DEFAULT_ACCENT_KEY).color
const themeModelCache = new Map<string, PlxThemeModel>()

function themeSeed(theme?: MantineTheme) {
	return theme?.other.plxAccentHex ?? DEFAULT_ACCENT_HEX
}

function createLogTheme(tokens: PlxThemeModel, seedHex: string): PlxLogTheme {
	const source = createMaterialThemeSource(seedHex)
	const { fatal, info, warning } = PLX_FIXED_LEVELS[tokens.mode]
	const surfaces = PLX_LOG_SURFACES[tokens.mode]
	const errorTone =
		tokens.mode === 'dark' ? toneHex(source.core.error, 82) : toneHex(source.core.error, 42)

	if (tokens.mode === 'dark') {
		return {
			panelBg: surfaces.panelBg,
			panelHeaderBg: surfaces.panelHeaderBg,
			listBg: surfaces.listBg,
			listStripe: alpha(tokens.app.text, 0.026),
			borderColor: tokens.app.borderStrong,
			border: `1px solid ${tokens.app.borderStrong}`,
			text: tokens.app.text,
			textMuted: tokens.app.textMuted,
			category: tokens.app.accentStrong,
			buttonBg: surfaces.buttonBg,
			buttonBgAccent: alpha(tokens.app.accent, 0.22),
			buttonText: tokens.app.text,
			inputBg: surfaces.inputBg,
			inputText: tokens.app.text,
			rowSelectedBg: alpha(tokens.app.accent, 0.16),
			errorText: errorTone,
			levels: {
				trace: surfaces.trace,
				debug: tokens.app.accent,
				info,
				warning,
				error: errorTone,
				fatal,
				default: tokens.app.text,
			},
			ansi16: PLX_LOG_ANSI16.dark,
		}
	}

	return {
		panelBg: surfaces.panelBg,
		panelHeaderBg: surfaces.panelHeaderBg,
		listBg: surfaces.listBg,
		listStripe: alpha(tokens.app.text, 0.018),
		borderColor: tokens.app.borderStrong,
		border: `1px solid ${tokens.app.borderStrong}`,
		text: tokens.app.text,
		textMuted: tokens.app.textMuted,
		category: tokens.app.accentStrong,
		buttonBg: surfaces.buttonBg,
		buttonBgAccent: alpha(tokens.app.accent, 0.14),
		buttonText: tokens.app.text,
		inputBg: surfaces.inputBg,
		inputText: tokens.app.text,
		rowSelectedBg: alpha(tokens.app.accent, 0.1),
		errorText: errorTone,
		levels: {
			trace: surfaces.trace,
			debug: tokens.app.accent,
			info,
			warning,
			error: errorTone,
			fatal,
			default: tokens.app.text,
		},
		ansi16: PLX_LOG_ANSI16.light,
	}
}

function buildThemeModel(seedHex: string, mode: PlxResolvedThemeMode): PlxThemeModel {
	const source = createMaterialThemeSource(seedHex)
	const { a1 } = source.core
	const isDark = mode === 'dark'
	const neutral = PLX_NEUTRAL_FOUNDATIONS[mode]

	const app = isDark
		? {
				bg: neutral.bg,
				bgAlt: neutral.bgAlt,
				surface: neutral.surface,
				surfaceStrong: neutral.surfaceStrong,
				surfaceMuted: neutral.surfaceMuted,
				border: neutral.border,
				borderStrong: neutral.borderStrong,
				text: neutral.text,
				textMuted: neutral.textMuted,
				accent: mix(toneHex(a1, 68), '#8ea092', 0.12),
				accentStrong: mix(toneHex(a1, 78), '#b1c1b5', 0.12),
				accentSoft: alpha(mix(toneHex(a1, 58), '#7f8f84', 0.22), 0.1),
				shadow: PLX_APP_SHADOWS.dark,
			}
		: {
				bg: neutral.bg,
				bgAlt: neutral.bgAlt,
				surface: neutral.surface,
				surfaceStrong: neutral.surfaceStrong,
				surfaceMuted: neutral.surfaceMuted,
				border: neutral.border,
				borderStrong: neutral.borderStrong,
				text: neutral.text,
				textMuted: neutral.textMuted,
				accent: mix(toneHex(a1, 42), '#5d7263', 0.12),
				accentStrong: mix(toneHex(a1, 32), '#435746', 0.08),
				accentSoft: alpha(mix(toneHex(a1, 68), '#9fb39f', 0.16), 0.09),
				shadow: PLX_APP_SHADOWS.light,
			}

	const controls = {
		selectedBg: isDark
			? mix(neutral.surfaceStrong, toneHex(a1, 76), 0.08)
			: mix(neutral.surfaceStrong, toneHex(a1, 92), 0.14),
		selectedBorder: isDark ? alpha(app.accentStrong, 0.26) : alpha(app.accent, 0.22),
	}

	const workbench = isDark
		? {
				shellBg: neutral.shellBg,
				shellBgAlt: neutral.shellBgAlt,
				activityBg: neutral.activityBg,
				activityItemActive: alpha(app.accent, 0.12),
				topbarBg: neutral.topbarBg,
				tabbarBg: neutral.tabbarBg,
				surfaceCanvas: neutral.surface,
			}
		: {
				shellBg: neutral.shellBg,
				shellBgAlt: neutral.shellBgAlt,
				activityBg: neutral.activityBg,
				activityItemActive: alpha(app.accent, 0.08),
				topbarBg: neutral.topbarBg,
				tabbarBg: neutral.tabbarBg,
				surfaceCanvas: neutral.surface,
			}

	const tokens: PlxThemeModel = {
		mode,
		app,
		controls,
		workbench,
		log: {} as PlxLogTheme,
	}

	tokens.log = createLogTheme(tokens, seedHex)
	return tokens
}

export function resolveThemeMode(colorScheme?: MantineColorScheme): PlxResolvedThemeMode {
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

function toCssVariables(tokens: PlxThemeModel, theme: MantineTheme) {
	const brand = theme.colors.brand ?? []
	const isDark = tokens.mode === 'dark'
	return {
		'--plx-app-bg': tokens.app.bg,
		'--plx-app-bg-alt': tokens.app.bgAlt,
		'--plx-surface': tokens.app.surface,
		'--plx-surface-strong': tokens.app.surfaceStrong,
		'--plx-surface-muted': tokens.app.surfaceMuted,
		'--plx-panel-bg': tokens.app.surfaceStrong,
		'--plx-panel-bg-muted': tokens.app.surfaceMuted,
		'--plx-panel-border': tokens.app.border,
		'--plx-panel-border-strong': tokens.app.borderStrong,
		'--plx-border': tokens.app.border,
		'--plx-border-strong': tokens.app.borderStrong,
		'--plx-text': tokens.app.text,
		'--plx-text-muted': tokens.app.textMuted,
		'--plx-accent': tokens.app.accent,
		'--plx-accent-strong': tokens.app.accentStrong,
		'--plx-accent-soft': tokens.app.accentSoft,
		'--plx-selected-bg': tokens.controls.selectedBg,
		'--plx-selected-border': tokens.controls.selectedBorder,
		'--plx-shadow': tokens.app.shadow,
		'--plx-workbench-shell-bg': tokens.workbench.shellBg,
		'--plx-workbench-shell-bg-alt': tokens.workbench.shellBgAlt,
		'--plx-workbench-activity-bg': tokens.workbench.activityBg,
		'--plx-workbench-activity-item-active': tokens.workbench.activityItemActive,
		'--plx-workbench-topbar-bg': tokens.workbench.topbarBg,
		'--plx-workbench-tabbar-bg': tokens.workbench.tabbarBg,
		'--plx-workbench-surface-canvas': tokens.workbench.surfaceCanvas,
		'--plx-brand-1': brand[1] ?? tokens.app.surface,
		'--plx-brand-2': brand[2] ?? tokens.app.surfaceStrong,
		'--plx-brand-5': brand[5] ?? tokens.app.accent,
		'--plx-brand-6': brand[6] ?? tokens.app.accentStrong,
		'--plx-brand-7': brand[7] ?? tokens.app.accentStrong,
		'--plx-accent-contrast': isDark
			? toneHex(createMaterialThemeSource(themeSeed(theme)).core.n1, 6)
			: tokens.app.surfaceStrong,
		'--plx-dirty-dot': PLX_FIXED_LEVELS[tokens.mode].warning,
	}
}

export const appCssVariablesResolver: CSSVariablesResolver = (theme) => {
	const base = defaultCssVariablesResolver(theme)
	const seedHex = themeSeed(theme)
	const light = getThemeModel('light', seedHex)
	const dark = getThemeModel('dark', seedHex)

	return {
		variables: {
			...base.variables,
		},
		light: {
			...base.light,
			'--mantine-color-body': light.app.bgAlt,
			'--mantine-color-text': light.app.text,
			'--mantine-color-default': light.app.surfaceStrong,
			'--mantine-color-default-hover': light.app.surfaceMuted,
			'--mantine-color-default-color': light.app.text,
			'--mantine-color-default-border': light.app.borderStrong,
			'--mantine-color-dimmed': light.app.textMuted,
			'--mantine-color-placeholder': alpha(light.app.textMuted, 0.88),
			...toCssVariables(light, theme),
		},
		dark: {
			...base.dark,
			'--mantine-color-body': dark.app.bgAlt,
			'--mantine-color-text': dark.app.text,
			'--mantine-color-default': dark.app.surfaceStrong,
			'--mantine-color-default-hover': dark.app.surfaceMuted,
			'--mantine-color-default-color': dark.app.text,
			'--mantine-color-default-border': dark.app.borderStrong,
			'--mantine-color-dimmed': dark.app.textMuted,
			'--mantine-color-placeholder': alpha(dark.app.textMuted, 0.9),
			...toCssVariables(dark, theme),
		},
	}
}
