import {
	DEFAULT_THEME,
	mergeMantineTheme,
	mergeThemeOverrides,
	type MantineTheme,
} from '@mantine/core'
import { workbenchTheme } from '@pluxel/workbench/mantine'
import { getAccentPreset } from '../accent/accentPresets'

export interface PlxMantineThemeMetadata {
	plxAccentHex: string
	plxAccentKey: string
}

/** The public Workbench theme with the user's accent as `brand`; renderers share everything else. */
export function createMantineTheme(accentKey: string): MantineTheme {
	const preset = getAccentPreset(accentKey)
	return mergeMantineTheme(
		DEFAULT_THEME,
		mergeThemeOverrides(workbenchTheme, {
			colors: { brand: preset.palette },
			other: {
				plxAccentHex: preset.color,
				plxAccentKey: preset.key,
			} satisfies PlxMantineThemeMetadata,
		}),
	)
}
