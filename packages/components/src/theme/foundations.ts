import type { MantineColorsTuple } from '@mantine/core'

export type PlxThemeMode = 'light' | 'dark'

export type PlxNeutralFoundation = {
	bg: string
	bgAlt: string
	surface: string
	surfaceStrong: string
	surfaceMuted: string
	shellBg: string
	shellBgAlt: string
	text: string
	textMuted: string
	border: string
	borderStrong: string
	panelGradient: string
	tabbarBg: string
	topbarBg: string
	activityBg: string
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

export type PlxMantineShadows = {
	xs: string
	sm: string
	md: string
}

export const PLX_FONT_STACK =
	'Inter, "HarmonyOS Sans", "PingFang SC", "Microsoft Yahei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

export const PLX_MANTINE_COLORS = {
	black: '#101416',
	white: '#fcfdfb',
	teal: [
		'#edf9f4',
		'#d7f1e6',
		'#b0e0cb',
		'#84cfad',
		'#5bbd90',
		'#3aa775',
		'#2d845d',
		'#23684a',
		'#1c523b',
		'#173f2f',
	] as MantineColorsTuple,
}

export const PLX_NEUTRAL_FOUNDATIONS: Record<PlxThemeMode, PlxNeutralFoundation> = {
	dark: {
		bg: '#111315',
		bgAlt: '#15181a',
		surface: '#181b1e',
		surfaceStrong: '#1c2024',
		surfaceMuted: '#14181b',
		shellBg: '#0d0f11',
		shellBgAlt: '#121518',
		text: '#e6eaee',
		textMuted: '#9aa4af',
		border: 'rgba(150, 162, 173, 0.14)',
		borderStrong: 'rgba(164, 176, 188, 0.2)',
		panelGradient: 'linear-gradient(180deg, #1d2125 0%, #181c20 100%)',
		tabbarBg: 'rgba(19, 23, 26, 0.96)',
		topbarBg: 'rgba(22, 26, 29, 0.94)',
		activityBg: 'rgba(17, 20, 23, 0.98)',
	},
	light: {
		bg: '#f3f5f7',
		bgAlt: '#f7f8fa',
		surface: '#fbfcfd',
		surfaceStrong: '#ffffff',
		surfaceMuted: '#eef1f3',
		shellBg: '#eef2f4',
		shellBgAlt: '#f7f9fb',
		text: '#1a2027',
		textMuted: '#66727d',
		border: 'rgba(109, 121, 132, 0.14)',
		borderStrong: 'rgba(109, 121, 132, 0.19)',
		panelGradient: 'linear-gradient(180deg, #ffffff 0%, #f8fafc 100%)',
		tabbarBg: 'rgba(245, 247, 249, 0.96)',
		topbarBg: 'rgba(251, 252, 253, 0.94)',
		activityBg: 'rgba(247, 249, 251, 0.98)',
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
		panelBg: '#15191d',
		panelHeaderBg: '#1a1f24',
		listBg: '#101316',
		buttonBg: '#1b2025',
		inputBg: '#0f1316',
		trace: '#8f9aa4',
	},
	light: {
		panelBg: '#ffffff',
		panelHeaderBg: '#f6f8fa',
		listBg: '#fcfdff',
		buttonBg: '#f1f4f7',
		inputBg: '#ffffff',
		trace: '#66727d',
	},
}

export const PLX_APP_SHADOWS: Record<PlxThemeMode, string> = {
	dark: '0 14px 30px rgba(2, 6, 23, 0.24)',
	light: '0 8px 22px rgba(15, 23, 42, 0.04)',
}

export const PLX_MANTINE_SHADOWS: PlxMantineShadows = {
	xs: '0 1px 3px rgba(15, 23, 42, 0.03)',
	sm: '0 2px 8px rgba(15, 23, 42, 0.05)',
	md: '0 4px 16px rgba(15, 23, 42, 0.08)',
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
