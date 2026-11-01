import { DEFAULT_THEME, createTheme, mergeMantineTheme, type MantineTheme } from '@mantine/core'
import { getAccentPreset } from '../accent/accentPresets'
import { PLX_FONT_SIZES, PLX_MANTINE_COLORS, PLX_RADIUS } from '../core/themeTokens'
import {
	createMantinePaletteFromTonalPalette,
	createMaterialThemeSource,
} from '../core/tonalPalette'

export interface PlxMantineThemeMetadata {
	plxAccentHex: string
	plxAccentKey: string
}

const CJK_SAFE_TEXT_BOX_STYLES = {
	lineHeight: 1.2,
	textBoxEdge: 'auto',
	textBoxTrim: 'none',
} as const

export function createMantineTheme(accentKey: string): MantineTheme {
	const preset = getAccentPreset(accentKey)
	const material = createMaterialThemeSource(preset.color)

	return mergeMantineTheme(
		DEFAULT_THEME,
		createTheme({
			black: PLX_MANTINE_COLORS.black,
			white: PLX_MANTINE_COLORS.white,
			primaryColor: 'brand',
			primaryShade: { light: 6, dark: 5 },
			fontFamily:
				'"IBM Plex Sans", "Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
			fontFamilyMonospace: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
			// One radius for controls, cards and tags; overlays get the single larger step.
			defaultRadius: 'sm',
			radius: PLX_RADIUS,
			// Compact admin scale: every size the Shell uses maps to one of these steps.
			fontSizes: PLX_FONT_SIZES,
			lineHeights: { xs: '1.45', sm: '1.5', md: '1.5', lg: '1.45', xl: '1.35' },
			headings: {
				fontWeight: '600',
				sizes: {
					h1: { fontSize: '24px', lineHeight: '1.3' },
					h2: { fontSize: '20px', lineHeight: '1.35' },
					h3: { fontSize: '16px', lineHeight: '1.4' },
					h4: { fontSize: '14px', lineHeight: '1.45' },
					h5: { fontSize: '13px', lineHeight: '1.5' },
					h6: { fontSize: '12px', lineHeight: '1.5' },
				},
			},
			colors: {
				brand: preset.palette,
				gray: createMantinePaletteFromTonalPalette(material.core.n2),
				dark: PLX_MANTINE_COLORS.dark,
				teal: PLX_MANTINE_COLORS.teal,
			},
			other: {
				plxAccentHex: preset.color,
				plxAccentKey: preset.key,
			} satisfies PlxMantineThemeMetadata,
			components: {
				Button: {
					styles: {
						label: CJK_SAFE_TEXT_BOX_STYLES,
					},
				},
				Badge: {
					defaultProps: { radius: 'sm' },
					styles: {
						label: CJK_SAFE_TEXT_BOX_STYLES,
					},
				},
				Pill: {
					defaultProps: { radius: 'sm' },
					styles: {
						label: CJK_SAFE_TEXT_BOX_STYLES,
					},
				},
				Chip: {
					styles: {
						label: CJK_SAFE_TEXT_BOX_STYLES,
					},
				},
				TabsTab: {
					styles: {
						tabLabel: CJK_SAFE_TEXT_BOX_STYLES,
					},
				},
			},
		}),
	)
}
