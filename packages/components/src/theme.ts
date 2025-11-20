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
	primaryColor: 'violet',
	defaultRadius: 'md',
	focusRing: 'auto',
	colors: {
		brand: [
			'#f3f0ff',
			'#e6ddff',
			'#ccb7ff',
			'#b296ff',
			'#9b7fff',
			'#7e5cf9',
			'#6c47ec',
			'#5a39ce',
			'#4a31a8',
			'#2e1f6e',
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
