import { DEFAULT_THEME, createTheme, mergeMantineTheme, type MantineTheme } from '@mantine/core'
import { DEFAULT_ACCENT_KEY, getAccentPreset } from '../accent/accentPresets'
import { PLX_MANTINE_COLORS } from '../core/themeTokens'
import {
	createMantineDarkPaletteFromTonalPalette,
	createMantinePaletteFromTonalPalette,
	createMaterialThemeSource,
} from '../core/tonalPalette'

export interface PlxMantineMetadata {
	plxAccentHex: string
	plxAccentKey: string
}

function createAccentTheme(accentKey: string) {
	const preset = getAccentPreset(accentKey)
	const material = createMaterialThemeSource(preset.color)

	return createTheme({
		black: PLX_MANTINE_COLORS.black,
		white: PLX_MANTINE_COLORS.white,
		primaryColor: 'brand',
		primaryShade: { light: 6, dark: 5 },
		colors: {
			brand: preset.palette,
			gray: createMantinePaletteFromTonalPalette(material.core.n2),
			dark: createMantineDarkPaletteFromTonalPalette(material.core.n1),
			teal: PLX_MANTINE_COLORS.teal,
		},
		other: {
			plxAccentHex: preset.color,
			plxAccentKey: preset.key,
		} satisfies PlxMantineMetadata,
	})
}

export function createMantineAppTheme(accentKey: string): MantineTheme {
	return mergeMantineTheme(DEFAULT_THEME, createAccentTheme(accentKey))
}

export const defaultMantineAppTheme = createMantineAppTheme(DEFAULT_ACCENT_KEY)
