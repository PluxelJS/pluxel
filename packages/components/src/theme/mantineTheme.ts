import { DEFAULT_THEME, createTheme, mergeMantineTheme, rem, type MantineTheme } from '@mantine/core'
import { DEFAULT_COLOR_KEY, getColorPreset } from './colorPresets'
import { PLX_FONT_STACK, PLX_MANTINE_COLORS, PLX_MANTINE_SHADOWS } from './foundations'
import { createMantinePaletteFromTonalPalette, createMaterialThemeSource } from './material'

export interface PlxThemeOther {
	plxSeed: string
	plxColorKey: string
}

const VARS = {
	text: 'var(--plx-text)',
	textMuted: 'var(--plx-text-muted)',
	panelBg: 'var(--plx-panel-bg)',
	panelBorder: 'var(--plx-panel-border)',
	panelBorderStrong: 'var(--plx-panel-border-strong)',
	surface: 'var(--plx-surface)',
	surfaceStrong: 'var(--plx-surface-strong)',
	surfaceMuted: 'var(--plx-surface-muted)',
	accent: 'var(--plx-accent)',
	accentSoft: 'var(--plx-accent-soft)',
	stateErrorTitle: 'var(--plx-state-error-title)',
	tabActiveBorder: 'var(--plx-workbench-tab-active-border)',
	shadow: 'var(--plx-shadow)',
} as const

const panelSurfaceStyles = {
	backgroundColor: VARS.panelBg,
	borderColor: VARS.panelBorder,
}

const baseTheme = createTheme({
	fontFamily: PLX_FONT_STACK,
	headings: {
		fontFamily: PLX_FONT_STACK,
		fontWeight: '600',
		sizes: {
			h1: { fontSize: rem(32) },
			h2: { fontSize: rem(26) },
			h3: { fontSize: rem(22) },
		},
	},
	fontSizes: {
		xs: rem(12),
		sm: rem(14),
		md: rem(16),
		lg: rem(18),
		xl: rem(24),
	},
	lineHeights: {
		xs: '1.3',
		sm: '1.35',
		md: '1.5',
		lg: '1.4',
		xl: '1.3',
	},
	defaultRadius: 'md',
	focusRing: 'auto',
	shadows: PLX_MANTINE_SHADOWS,
	spacing: {
		xs: rem(8),
		sm: rem(12),
		md: rem(16),
		lg: rem(20),
		xl: rem(28),
	},
	components: {
		Button: {
			defaultProps: {
				radius: 'md',
				size: 'sm',
			},
			styles: {
				root: {
					fontWeight: 600,
					letterSpacing: '0.01em',
				},
			},
		},
		ActionIcon: {
			defaultProps: {
				variant: 'subtle',
				size: 'md',
			},
			styles: {
				root: {
					color: VARS.textMuted,
					borderColor: 'transparent',
					'&[data-variant="default"]': {
						backgroundColor: VARS.panelBg,
						border: `1px solid ${VARS.panelBorder}`,
						color: VARS.text,
					},
					'&[data-variant="subtle"]:hover, &[data-variant="light"]:hover': {
						backgroundColor: VARS.surfaceMuted,
						color: VARS.text,
					},
				},
			},
		},
		Badge: {
			styles: {
				root: {
					fontWeight: 600,
					letterSpacing: '0.01em',
					'&[data-variant="light"]': {
						backgroundColor: `color-mix(in srgb, var(--badge-bg) 90%, ${VARS.panelBg} 10%)`,
						border: `1px solid color-mix(in srgb, var(--badge-bg) 56%, ${VARS.panelBorder} 44%)`,
						color: 'var(--badge-color)',
					},
					'&[data-variant="outline"]': {
						backgroundColor: `color-mix(in srgb, ${VARS.panelBg} 92%, transparent)`,
						border: `1px solid color-mix(in srgb, var(--badge-color) 28%, ${VARS.panelBorder} 72%)`,
						color: 'var(--badge-color)',
					},
					'&[data-variant="dot"]': {
						backgroundColor: `color-mix(in srgb, ${VARS.panelBg} 94%, transparent)`,
						border: `1px solid ${VARS.panelBorder}`,
						color: VARS.text,
					},
				},
			},
		},
		Card: {
			defaultProps: {
				padding: 'md',
				radius: 'md',
				shadow: 'sm',
			},
			styles: { root: panelSurfaceStyles },
		},
		Paper: {
			defaultProps: {
				padding: 'md',
				radius: 'md',
				shadow: 'xs',
			},
			styles: { root: panelSurfaceStyles },
		},
		Input: {
			styles: {
				label: {
					color: VARS.text,
					fontWeight: 600,
					marginBottom: 6,
				},
				description: {
					color: VARS.textMuted,
				},
				error: {
					color: VARS.stateErrorTitle,
				},
				input: {
					backgroundColor: VARS.surfaceStrong,
					border: `1px solid ${VARS.panelBorderStrong}`,
					color: VARS.text,
					'&::placeholder': {
						color: VARS.textMuted,
						opacity: 0.96,
					},
					'&:focus, &:focus-within': {
						borderColor: VARS.accent,
						boxShadow: `0 0 0 1px ${VARS.accentSoft}`,
					},
				},
				section: {
					color: VARS.textMuted,
				},
			},
		},
		Combobox: {
			styles: {
				dropdown: {
					backgroundColor: VARS.panelBg,
					border: `1px solid ${VARS.panelBorderStrong}`,
					boxShadow: VARS.shadow,
				},
				options: {
					gap: 2,
				},
				option: {
					borderRadius: 8,
					color: VARS.text,
					'&[data-combobox-selected]': {
						backgroundColor: VARS.surface,
						color: VARS.text,
					},
					'&[data-combobox-active], &:hover': {
						backgroundColor: VARS.surfaceMuted,
						color: VARS.text,
					},
				},
				empty: {
					color: VARS.textMuted,
				},
				groupLabel: {
					color: VARS.textMuted,
					fontWeight: 700,
					letterSpacing: '0.02em',
				},
				search: {
					backgroundColor: VARS.surface,
					borderColor: VARS.panelBorder,
					color: VARS.text,
				},
			},
		},
		Tabs: {
			styles: {
				list: {
					gap: 4,
					borderBottomColor: VARS.panelBorder,
				},
				tab: {
					borderRadius: 8,
					color: VARS.textMuted,
					border: '1px solid transparent',
					minHeight: 30,
					paddingInline: 10,
					'&[data-active]': {
						backgroundColor: VARS.surface,
						borderColor: VARS.tabActiveBorder,
						color: VARS.text,
					},
					'&:hover': {
						backgroundColor: VARS.surfaceMuted,
						color: VARS.text,
					},
				},
				panel: {
					color: VARS.text,
				},
			},
		},
	},
})

function createColorTheme(colorKey: string) {
	const preset = getColorPreset(colorKey)
	const material = createMaterialThemeSource(preset.color)

	return createTheme({
		black: PLX_MANTINE_COLORS.black,
		white: PLX_MANTINE_COLORS.white,
		primaryColor: 'brand',
		primaryShade: { light: 6, dark: 5 },
		colors: {
			brand: preset.palette,
			gray: createMantinePaletteFromTonalPalette(material.core.n2),
			dark: createMantinePaletteFromTonalPalette(material.core.n1),
			teal: PLX_MANTINE_COLORS.teal,
		},
		other: {
			plxSeed: preset.color,
			plxColorKey: preset.key,
		} satisfies PlxThemeOther,
	})
}

export function createDynamicTheme(colorKey: string): MantineTheme {
	const colorTheme = createColorTheme(colorKey)

	return mergeMantineTheme(DEFAULT_THEME, {
		...baseTheme,
		...colorTheme,
		components: {
			...baseTheme.components,
			...colorTheme.components,
		},
		colors: {
			...baseTheme.colors,
			...colorTheme.colors,
		},
		other: {
			...baseTheme.other,
			...colorTheme.other,
		},
		headings: {
			...baseTheme.headings,
			...colorTheme.headings,
		},
		fontSizes: {
			...baseTheme.fontSizes,
			...colorTheme.fontSizes,
		},
		lineHeights: {
			...baseTheme.lineHeights,
			...colorTheme.lineHeights,
		},
		shadows: {
			...baseTheme.shadows,
			...colorTheme.shadows,
		},
		spacing: {
			...baseTheme.spacing,
			...colorTheme.spacing,
		},
	})
}

export const theme = createDynamicTheme(DEFAULT_COLOR_KEY)
