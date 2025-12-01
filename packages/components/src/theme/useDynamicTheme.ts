import { createTheme, mergeMantineTheme, rem, type MantineTheme } from '@mantine/core'
import { useLocalStorage } from '@mantine/hooks'
import { useCallback, useEffect, useMemo, useState } from 'react'
import {
	COLOR_PRESETS,
	DEFAULT_COLOR_KEY,
	getColorPreset,
	THEME_CHANGE_EVENT,
	THEME_COLOR_STORAGE_KEY,
} from './colorPresets'

const fontStack =
	'Inter, "HarmonyOS Sans", "PingFang SC", "Microsoft Yahei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

/** 基础主题配置（不包含颜色） */
const baseTheme = createTheme({
	fontFamily: fontStack,
	headings: {
		fontFamily: fontStack,
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
	primaryColor: 'brand',
	defaultRadius: 'md',
	focusRing: 'auto',
	shadows: {
		xs: '0 1px 3px rgba(15, 23, 42, 0.03)',
		sm: '0 2px 8px rgba(15, 23, 42, 0.05)',
		md: '0 4px 16px rgba(15, 23, 42, 0.08)',
	},
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
				},
			},
		},
		ActionIcon: {
			defaultProps: {
				variant: 'subtle',
				size: 'md',
			},
		},
		Card: {
			defaultProps: {
				padding: 'md',
				radius: 'md',
				shadow: 'sm',
			},
		},
		Paper: {
			defaultProps: {
				padding: 'md',
				radius: 'md',
				shadow: 'xs',
			},
		},
	},
})

/** 根据颜色 key 创建完整主题 */
export function createDynamicTheme(colorKey: string): MantineTheme {
	const preset = getColorPreset(colorKey)
	const colorTheme = createTheme({
		colors: {
			brand: preset.palette,
			// 保留 teal 用于状态指示
			teal: [
				'#e6fcf5',
				'#c3fae8',
				'#96f2d7',
				'#63e6be',
				'#38d9a9',
				'#20c997',
				'#12b886',
				'#0ca678',
				'#099268',
				'#087f5b',
			],
		},
	})
	return mergeMantineTheme(baseTheme, colorTheme)
}

/** 动态主题 Hook */
export function useDynamicTheme() {
	const [colorKey, setColorKey] = useLocalStorage<string>({
		key: THEME_COLOR_STORAGE_KEY,
		defaultValue: DEFAULT_COLOR_KEY,
		getInitialValueInEffect: true,
	})

	// 确保初始值有效
	const [initialized, setInitialized] = useState(false)
	useEffect(() => {
		setInitialized(true)
	}, [])

	const safeColorKey = initialized ? colorKey : DEFAULT_COLOR_KEY

	// 监听主题变更事件
	useEffect(() => {
		const handler = (event: Event) => {
			const detail = (event as CustomEvent<{ accentColor?: string }>).detail
			if (detail?.accentColor) {
				setColorKey(detail.accentColor)
			}
		}
		window.addEventListener(THEME_CHANGE_EVENT, handler as EventListener)
		return () => window.removeEventListener(THEME_CHANGE_EVENT, handler as EventListener)
	}, [setColorKey])

	const theme = useMemo(() => createDynamicTheme(safeColorKey), [safeColorKey])

	const setThemeColor = useCallback(
		(key: string) => {
			const preset = COLOR_PRESETS.find((p) => p.key === key)
			if (preset) {
				setColorKey(key)
			}
		},
		[setColorKey],
	)

	return {
		theme,
		colorKey: safeColorKey,
		setThemeColor,
		presets: COLOR_PRESETS,
	}
}
