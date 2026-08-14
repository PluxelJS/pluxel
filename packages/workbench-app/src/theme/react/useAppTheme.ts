import { useLocalStorage } from '@mantine/hooks'
import { useCallback, useMemo } from 'react'
import {
	ACCENT_PRESETS,
	ACCENT_STORAGE_KEY,
	DEFAULT_ACCENT_KEY,
	normalizeAccentKey,
} from '../accent/accentPresets'
import { createMantineAppTheme } from '../mantine/mantineAdapter'

export type { PlxMantineMetadata } from '../mantine/mantineAdapter'

export function useAccentTheme() {
	const [storedAccentKey, setStoredAccentKey] = useLocalStorage<string>({
		key: ACCENT_STORAGE_KEY,
		defaultValue: DEFAULT_ACCENT_KEY,
		getInitialValueInEffect: true,
	})

	const setAccentTheme = useCallback(
		(key: string) => {
			setStoredAccentKey(normalizeAccentKey(key))
		},
		[setStoredAccentKey],
	)

	const accentKey = normalizeAccentKey(storedAccentKey)

	return {
		accentKey,
		setAccentTheme,
		presets: ACCENT_PRESETS,
	}
}

/** 动态主题 Hook */
export function useAppTheme() {
	const { accentKey, setAccentTheme, presets } = useAccentTheme()
	const theme = useMemo(() => createMantineAppTheme(accentKey), [accentKey])

	return {
		theme,
		accentKey,
		setAccentTheme,
		presets,
	}
}
