import { createTheme, rem } from '@mantine/core'

const fontStack =
	'Inter, "HarmonyOS Sans", "PingFang SC", "Microsoft Yahei", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'

export const theme = createTheme({
	fontFamily: fontStack,
	headings: {
		fontFamily: fontStack,
		fontWeight: 600,
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
	colors: {
		brand: [
			'#f2f6ff', // 0 - 最浅
			'#dfe9ff', // 1
			'#bfd2ff', // 2
			'#9ab8ff', // 3
			'#769eff', // 4
			'#5b8cff', // 5 - 中等
			'#3f6fdd', // 6
			'#345ac1', // 7
			'#2c4da3', // 8
			'#1d3470', // 9 - 最深
		],
		// 添加柔和的 teal 色系用于状态指示
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
	shadows: {
		xs: '0 1px 3px rgba(15, 23, 42, 0.03)', // 降低阴影强度
		sm: '0 2px 8px rgba(15, 23, 42, 0.05)', // 更柔和的阴影
		md: '0 4px 16px rgba(15, 23, 42, 0.08)', // 降低深度感
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
