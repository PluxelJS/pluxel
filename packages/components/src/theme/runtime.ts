import { useLocalStorage } from '@mantine/hooks'
import { useCallback, useMemo } from 'react'
import {
	COLOR_PRESETS,
	DEFAULT_COLOR_KEY,
	resolveThemeColorKey,
	THEME_COLOR_STORAGE_KEY,
} from './colorPresets'
import { createDynamicTheme } from './mantineTheme'

export type { PlxThemeOther } from './mantineTheme'

export function useThemeColorKey() {
	const [storedColorKey, setStoredColorKey] = useLocalStorage<string>({
		key: THEME_COLOR_STORAGE_KEY,
		defaultValue: DEFAULT_COLOR_KEY,
		getInitialValueInEffect: true,
	})

	const setThemeColor = useCallback(
		(key: string) => {
			setStoredColorKey(resolveThemeColorKey(key))
		},
		[setStoredColorKey],
	)

	const colorKey = resolveThemeColorKey(storedColorKey)

	return {
		colorKey,
		setThemeColor,
		presets: COLOR_PRESETS,
	}
}

/** 动态主题 Hook */
export function useDynamicTheme() {
	const { colorKey, setThemeColor, presets } = useThemeColorKey()
	const theme = useMemo(() => createDynamicTheme(colorKey), [colorKey])

	return {
		theme,
		colorKey,
		setThemeColor,
		presets,
	}
}
