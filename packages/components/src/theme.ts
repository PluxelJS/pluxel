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
			'#f2f6ff',
			'#dfe9ff',
			'#bfd2ff',
			'#9ab8ff',
			'#769eff',
			'#5b8cff',
			'#3f6fdd',
			'#345ac1',
			'#2c4da3',
			'#1d3470',
		],
	},
	shadows: {
		xs: '0 1px 2px rgba(15, 23, 42, 0.04)',
		sm: '0 4px 12px rgba(15, 23, 42, 0.08)',
		md: '0 10px 30px rgba(15, 23, 42, 0.12)',
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
