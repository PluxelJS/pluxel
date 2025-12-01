// Mantine theme configuration
export { theme } from './mantine'

// Color presets
export {
	COLOR_PRESETS,
	DEFAULT_COLOR_KEY,
	getColorPreset,
	THEME_CHANGE_EVENT,
	THEME_COLOR_STORAGE_KEY,
	type ColorPreset,
} from './colorPresets'

// Background patterns
export { getPatternStyle, patternBackgrounds, type PatternScheme } from './patterns'

// Dynamic theme hook
export { createDynamicTheme, useDynamicTheme } from './useDynamicTheme'
