import { DEFAULT_COLOR_KEY, getColorPreset } from './colorPresets'
import { getPlxScheme, type PlxResolvedColorScheme } from './schemes'

export type PatternScheme = PlxResolvedColorScheme

type PatternStyle = {
	backgroundColor: string
	backgroundImage: string
	backgroundSize: string
	backgroundPosition?: string
	backgroundAttachment?: string
}

const DEFAULT_SEED_HEX = getColorPreset(DEFAULT_COLOR_KEY).color

export const patternBackgrounds: Record<PatternScheme, PatternStyle> = {
	light: getPlxScheme('light', DEFAULT_SEED_HEX).pattern,
	dark: getPlxScheme('dark', DEFAULT_SEED_HEX).pattern,
}

export const getPatternStyle = (scheme: PatternScheme, seedHex = DEFAULT_SEED_HEX) =>
	getPlxScheme(scheme, seedHex).pattern
