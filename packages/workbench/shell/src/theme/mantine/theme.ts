import { DEFAULT_THEME, createTheme, mergeMantineTheme, type MantineTheme } from '@mantine/core'
import { getAccentPreset } from '../accent/accentPresets'
import { PLX_MANTINE_COLORS } from '../core/themeTokens'
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
					styles: {
						label: CJK_SAFE_TEXT_BOX_STYLES,
					},
				},
				Pill: {
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
