import {
	defaultCssVariablesResolver,
	type CSSVariablesResolver,
	type MantineColorScheme,
	type MantineTheme,
	useComputedColorScheme,
	useMantineTheme,
} from '@mantine/core'
import { useMemo } from 'react'
import { DEFAULT_COLOR_KEY, getColorPreset } from './colorPresets'
import {
	PLX_APP_SHADOWS,
	PLX_FIXED_LEVELS,
	PLX_LOG_ANSI16,
	PLX_LOG_SURFACES,
	PLX_NEUTRAL_FOUNDATIONS,
	type PlxThemeMode,
} from './foundations'
import { alpha, createMaterialThemeSource, mix, toneHex } from './material'

export type PlxResolvedColorScheme = PlxThemeMode

type PatternTokens = {
	backgroundColor: string
	backgroundImage: string
	backgroundSize: string
	backgroundPosition?: string
	backgroundAttachment?: string
}

type StateTokens = {
	bg: string
	border: string
	iconBg: string
	iconColor: string
	titleColor: string
}

export type PlxLogPalette = {
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

export type PlxSchemeTokens = {
	mode: PlxResolvedColorScheme
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
		panelGradient: string
		shadow: string
	}
	controls: {
		segmentedHoverBg: string
		segmentedActiveBg: string
		segmentedBorder: string
	}
	workbench: {
		shellBg: string
		shellBgAlt: string
		activityBg: string
		activityItemActive: string
		topbarBg: string
		tabbarBg: string
		surfaceCanvas: string
		tabActiveBg: string
		tabActiveBorder: string
	}
	pattern: PatternTokens
	state: {
		empty: StateTokens
		error: StateTokens
	}
	log: PlxLogPalette
}

const DEFAULT_SEED_HEX = getColorPreset(DEFAULT_COLOR_KEY).color
const schemeCache = new Map<string, PlxSchemeTokens>()

function themeSeed(theme?: MantineTheme) {
	return theme?.other.plxSeed ?? DEFAULT_SEED_HEX
}

function createPattern(mode: PlxResolvedColorScheme, backgroundColor: string, accent: string, neutral: string) {
	if (mode === 'dark') {
		return {
			backgroundColor,
			backgroundImage: `
				linear-gradient(to right, ${alpha(neutral, 0.11)} 1px, transparent 1px),
				linear-gradient(to bottom, ${alpha(neutral, 0.11)} 1px, transparent 1px),
				radial-gradient(circle 560px at 10% 0%, ${alpha(accent, 0.16)} 0%, transparent 64%),
				radial-gradient(circle 540px at 100% 0%, ${alpha(neutral, 0.12)} 0%, transparent 62%)
			`,
			backgroundSize: '48px 48px, 48px 48px, 100% 100%, 100% 100%',
		}
	}
	return {
		backgroundColor,
		backgroundImage: `
			linear-gradient(to right, ${alpha(neutral, 0.1)} 1px, transparent 1px),
			linear-gradient(to bottom, ${alpha(neutral, 0.1)} 1px, transparent 1px),
			radial-gradient(circle 580px at 0% 0%, ${alpha(accent, 0.14)} 0%, transparent 66%),
			radial-gradient(circle 540px at 100% 0%, ${alpha(neutral, 0.08)} 0%, transparent 64%)
		`,
		backgroundSize: '48px 48px, 48px 48px, 100% 100%, 100% 100%',
	}
}

function createLogPalette(tokens: PlxSchemeTokens, seedHex: string): PlxLogPalette {
	const source = createMaterialThemeSource(seedHex)
	const { fatal, info, warning } = PLX_FIXED_LEVELS[tokens.mode]
	const surfaces = PLX_LOG_SURFACES[tokens.mode]
	const errorTone = tokens.mode === 'dark' ? toneHex(source.core.error, 82) : toneHex(source.core.error, 42)

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

function buildPlxScheme(seedHex: string, mode: PlxResolvedColorScheme): PlxSchemeTokens {
	const source = createMaterialThemeSource(seedHex)
	const { a1, error } = source.core
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
				panelGradient: neutral.panelGradient,
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
				panelGradient: neutral.panelGradient,
				shadow: PLX_APP_SHADOWS.light,
			}

	const controls = {
		segmentedHoverBg: neutral.surface,
		segmentedActiveBg: neutral.surfaceStrong,
		segmentedBorder: neutral.borderStrong,
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
				tabActiveBg: neutral.surfaceStrong,
				tabActiveBorder: alpha(app.accent, 0.16),
			}
		: {
				shellBg: neutral.shellBg,
				shellBgAlt: neutral.shellBgAlt,
				activityBg: neutral.activityBg,
				activityItemActive: alpha(app.accent, 0.08),
				topbarBg: neutral.topbarBg,
				tabbarBg: neutral.tabbarBg,
				surfaceCanvas: neutral.surface,
				tabActiveBg: neutral.surfaceStrong,
				tabActiveBorder: alpha(app.accent, 0.12),
			}

	const tokens: PlxSchemeTokens = {
		mode,
		app,
		controls,
		workbench,
		pattern: createPattern(mode, app.bgAlt, app.accent, app.textMuted),
		state: {
			empty: {
				bg: neutral.surfaceStrong,
				border: app.border,
				iconBg: app.accentSoft,
				iconColor: app.accentStrong,
				titleColor: app.text,
			},
			error: {
				bg: isDark ? alpha(toneHex(error, 24), 0.54) : toneHex(error, 96),
				border: isDark ? alpha(toneHex(error, 76), 0.22) : alpha(toneHex(error, 50), 0.18),
				iconBg: isDark ? alpha(toneHex(error, 66), 0.18) : alpha(toneHex(error, 64), 0.12),
				iconColor: isDark ? toneHex(error, 86) : toneHex(error, 42),
				titleColor: isDark ? toneHex(error, 92) : toneHex(error, 30),
			},
		},
		log: {} as PlxLogPalette,
	}

	tokens.log = createLogPalette(tokens, seedHex)
	return tokens
}

export function resolvePlxColorScheme(colorScheme?: MantineColorScheme): PlxResolvedColorScheme {
	return colorScheme === 'dark' ? 'dark' : 'light'
}

export function getPlxScheme(
	colorScheme?: MantineColorScheme,
	seedHex = DEFAULT_SEED_HEX,
): PlxSchemeTokens {
	const mode = resolvePlxColorScheme(colorScheme)
	const key = `${mode}:${seedHex.toLowerCase()}`
	const cached = schemeCache.get(key)
	if (cached) return cached
	const next = buildPlxScheme(seedHex, mode)
	schemeCache.set(key, next)
	return next
}

export function usePlxScheme() {
	const colorScheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const theme = useMantineTheme()
	const seedHex = themeSeed(theme)
	return useMemo(() => getPlxScheme(colorScheme, seedHex), [colorScheme, seedHex])
}

function toCssVariables(tokens: PlxSchemeTokens, theme: MantineTheme) {
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
		'--plx-panel-accent-bg': tokens.app.accentSoft,
		'--plx-panel-accent-fg': tokens.app.accentStrong,
		'--plx-border': tokens.app.border,
		'--plx-border-strong': tokens.app.borderStrong,
		'--plx-text': tokens.app.text,
		'--plx-text-muted': tokens.app.textMuted,
		'--plx-accent': tokens.app.accent,
		'--plx-accent-strong': tokens.app.accentStrong,
		'--plx-accent-soft': tokens.app.accentSoft,
		'--plx-segmented-hover-bg': tokens.controls.segmentedHoverBg,
		'--plx-segmented-active-bg': tokens.controls.segmentedActiveBg,
		'--plx-segmented-border': tokens.controls.segmentedBorder,
		'--plx-panel-gradient': tokens.app.panelGradient,
		'--plx-shadow': tokens.app.shadow,
		'--plx-state-empty-bg': tokens.state.empty.bg,
		'--plx-state-empty-border': tokens.state.empty.border,
		'--plx-state-empty-icon-bg': tokens.state.empty.iconBg,
		'--plx-state-empty-icon-color': tokens.state.empty.iconColor,
		'--plx-state-empty-title': tokens.state.empty.titleColor,
		'--plx-state-error-bg': tokens.state.error.bg,
		'--plx-state-error-border': tokens.state.error.border,
		'--plx-state-error-icon-bg': tokens.state.error.iconBg,
		'--plx-state-error-icon-color': tokens.state.error.iconColor,
		'--plx-state-error-title': tokens.state.error.titleColor,
		'--plx-workbench-shell-bg': tokens.workbench.shellBg,
		'--plx-workbench-shell-bg-alt': tokens.workbench.shellBgAlt,
		'--plx-workbench-activity-bg': tokens.workbench.activityBg,
		'--plx-workbench-activity-item-active': tokens.workbench.activityItemActive,
		'--plx-workbench-topbar-bg': tokens.workbench.topbarBg,
		'--plx-workbench-tabbar-bg': tokens.workbench.tabbarBg,
		'--plx-workbench-surface-canvas': tokens.workbench.surfaceCanvas,
		'--plx-workbench-tab-active-bg': tokens.workbench.tabActiveBg,
		'--plx-workbench-tab-active-border': tokens.workbench.tabActiveBorder,
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

export const plxCssVariablesResolver: CSSVariablesResolver = (theme) => {
	const base = defaultCssVariablesResolver(theme)
	const seedHex = themeSeed(theme)
	const light = getPlxScheme('light', seedHex)
	const dark = getPlxScheme('dark', seedHex)

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
