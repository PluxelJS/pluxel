import {
	ActionIcon,
	Badge,
	Button,
	Card,
	Chip,
	createTheme,
	HoverCard,
	Input,
	InputWrapper,
	Menu,
	Modal,
	Notification,
	Paper,
	Pill,
	Popover,
	SegmentedControl,
	Tabs,
	Text,
	ThemeIcon,
	Tooltip,
	type MantineColorsTuple,
	type MantineThemeOverride,
} from '@mantine/core'

/*
 * Workbench Mantine theme. The Shell owns the document-level CSS variables (surfaces, accent and
 * colour scheme); this object carries the structure every Workbench React root must agree on:
 * scale, fonts, colour names and component defaults.
 */

type Scale = Readonly<Record<string, number>>

/** Neutral greys with a slight cool bias. `dark[7]` is the document surface, `dark[8]` the canvas. */
const DARK: MantineColorsTuple = [
	'#e4e5e9',
	'#b9bcc3',
	'#8b909a',
	'#666b74',
	'#303237',
	'#25272b',
	'#1b1c20',
	'#151619',
	'#0e0f11',
	'#0a0b0c',
]

const GRAY: MantineColorsTuple = [
	'#f7f8f9',
	'#f1f2f4',
	'#e6e8eb',
	'#d6d9de',
	'#b4b9c1',
	'#8b909a',
	'#646a75',
	'#4a4f58',
	'#31353c',
	'#1b1e24',
]

/** Low-chroma hue family: badges, alerts and plugin colours stay in one calm register. */
const HUES = {
	red: [
		'#fff8f7',
		'#fff0ef',
		'#ffe2de',
		'#ffcbc6',
		'#fda49c',
		'#d8857e',
		'#b36760',
		'#904a45',
		'#73332f',
		'#571e1a',
	],
	pink: [
		'#fff8f8',
		'#fff0f3',
		'#ffe0e9',
		'#ffc9db',
		'#f4a5c2',
		'#d085a1',
		'#ad6782',
		'#8a4a64',
		'#6f334c',
		'#531d35',
	],
	grape: [
		'#fff7fb',
		'#ffeffd',
		'#fedeff',
		'#f8c7ff',
		'#dcabe4',
		'#ba8bc2',
		'#996ca1',
		'#794f82',
		'#5f3868',
		'#472150',
	],
	violet: [
		'#fff7ff',
		'#fbf0ff',
		'#f3e2ff',
		'#e7cdff',
		'#ceafee',
		'#ac8fcc',
		'#8c70ab',
		'#6d538b',
		'#543b71',
		'#3d2459',
	],
	indigo: [
		'#fbf8ff',
		'#f3f2ff',
		'#e5e6ff',
		'#cfd5ff',
		'#adb8f6',
		'#8d98d3',
		'#6e79b2',
		'#505b92',
		'#384379',
		'#212c61',
	],
	blue: [
		'#f8f9ff',
		'#eef4ff',
		'#dbe9ff',
		'#bed9ff',
		'#96bff1',
		'#759ecf',
		'#567fae',
		'#36618e',
		'#1a4975',
		'#003259',
	],
	cyan: [
		'#f0fbff',
		'#e0f8ff',
		'#bef0ff',
		'#98e2f6',
		'#7cc6da',
		'#5ba6b8',
		'#388698',
		'#086879',
		'#004e5c',
		'#003640',
	],
	teal: [
		'#e5fff7',
		'#c7fff1',
		'#acf7e5',
		'#9be5d4',
		'#80c9b9',
		'#5fa899',
		'#3e887a',
		'#196a5c',
		'#005045',
		'#00382f',
	],
	green: [
		'#eaffe9',
		'#d1ffd6',
		'#baf7c3',
		'#a9e5b3',
		'#8ec998',
		'#6fa87a',
		'#50885d',
		'#326941',
		'#17512b',
		'#003918',
	],
	lime: [
		'#f2ffce',
		'#e6fdac',
		'#daf1a2',
		'#cae092',
		'#aec479',
		'#8ea35c',
		'#708340',
		'#526525',
		'#3b4d0f',
		'#263500',
	],
	yellow: [
		'#fff8f0',
		'#fff2d8',
		'#ffe6a4',
		'#f3d57b',
		'#d6b963',
		'#b49946',
		'#927a2a',
		'#725c0c',
		'#574500',
		'#3c2f00',
	],
	orange: [
		'#fff8f5',
		'#fff1ea',
		'#ffe3d3',
		'#ffcdaf',
		'#f8aa77',
		'#d38a5a',
		'#ae6c3f',
		'#8b4f25',
		'#6e380f',
		'#512400',
	],
} satisfies Record<string, MantineColorsTuple>

/* Control heights in px. One step tighter than Mantine defaults for a 13px body. */
const BUTTON_HEIGHT: Scale = {
	xs: 26,
	sm: 30,
	md: 34,
	lg: 40,
	xl: 46,
	'compact-xs': 22,
	'compact-sm': 26,
	'compact-md': 30,
}
const INPUT_HEIGHT: Scale = { xs: 26, sm: 30, md: 34, lg: 40, xl: 46 }
const ACTION_ICON_SIZE: Scale = { xs: 22, sm: 26, md: 30, lg: 36, xl: 42 }
const THEME_ICON_SIZE: Scale = { xs: 18, sm: 22, md: 28, lg: 34, xl: 40 }
const BADGE_HEIGHT: Scale = { xs: 16, sm: 18, md: 20, lg: 24, xl: 28 }
/* Badge labels stay legible for CJK; Mantine's 9–11px defaults are too small. */
const BADGE_FONT_SIZE: Scale = { xs: 11, sm: 11, md: 12, lg: 13, xl: 14 }

function px(value: number) {
	return `${value / 16}rem`
}

/** A size-keyed CSS variable override; unknown or custom sizes keep Mantine's own resolution. */
function sized(variable: string, scale: Scale, size: unknown, fallback = 'sm') {
	const key = typeof size === 'string' ? size : size === undefined ? fallback : null
	const value = key === null ? undefined : scale[key]
	return value === undefined ? {} : { [variable]: px(value) }
}

/** Mantine's text-box trimming clips CJK glyphs inside fixed-height labels. */
const CJK_SAFE_LABEL = {
	lineHeight: 1.2,
	textBoxEdge: 'auto',
	textBoxTrim: 'none',
} as const

/**
 * Theme every Workbench Mantine root uses. Shell and Plugin renderers share the same scale,
 * fonts, colour names and component defaults; the active accent and surfaces come from the
 * Shell's CSS variables, so renderers follow the user's appearance without a second resolver.
 */
export const workbenchTheme: MantineThemeOverride = createTheme({
	black: '#0e0f11',
	white: '#ffffff',
	primaryColor: 'brand',
	// Shade 7 keeps white labels on filled controls above WCAG AA (4.5:1) for every accent preset.
	primaryShade: { light: 7, dark: 7 },
	autoContrast: true,
	// System UI fonts first so Latin text keeps its own glyphs; CJK families cover the rest.
	fontFamily:
		'-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "PingFang SC", "Noto Sans SC", "Microsoft YaHei", sans-serif',
	fontFamilyMonospace: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
	fontSmoothing: true,
	defaultRadius: 'sm',
	radius: { xs: '4px', sm: '6px', md: '8px', lg: '10px', xl: '14px' },
	fontSizes: { xs: '12px', sm: '13px', md: '14px', lg: '16px', xl: '20px' },
	lineHeights: { xs: '1.45', sm: '1.5', md: '1.55', lg: '1.5', xl: '1.4' },
	spacing: { xs: '8px', sm: '12px', md: '16px', lg: '20px', xl: '28px' },
	shadows: {
		xs: '0 1px 2px rgba(10, 12, 16, 0.08)',
		sm: '0 1px 3px rgba(10, 12, 16, 0.1), 0 1px 2px rgba(10, 12, 16, 0.06)',
		md: '0 8px 24px -6px rgba(10, 12, 16, 0.28), 0 2px 6px rgba(10, 12, 16, 0.1)',
		lg: '0 16px 40px -8px rgba(10, 12, 16, 0.34), 0 4px 12px rgba(10, 12, 16, 0.12)',
		xl: '0 24px 64px -12px rgba(10, 12, 16, 0.4), 0 8px 20px rgba(10, 12, 16, 0.14)',
	},
	headings: {
		fontWeight: '600',
		sizes: {
			h1: { fontSize: '22px', lineHeight: '1.3' },
			h2: { fontSize: '18px', lineHeight: '1.35' },
			h3: { fontSize: '15px', lineHeight: '1.4' },
			h4: { fontSize: '14px', lineHeight: '1.45' },
			h5: { fontSize: '13px', lineHeight: '1.5' },
			h6: { fontSize: '12px', lineHeight: '1.5' },
		},
	},
	colors: {
		...HUES,
		// The Shell replaces `brand` with the user's accent; the default matches its default preset.
		brand: HUES.blue,
		gray: GRAY,
		dark: DARK,
	},
	components: {
		// Icon buttons are chrome: quiet by default, accent only where a caller asks for it.
		ActionIcon: ActionIcon.extend({
			defaultProps: { color: 'gray', variant: 'subtle' },
			vars: (_theme, props) => ({ root: sized('--ai-size', ACTION_ICON_SIZE, props.size, 'md') }),
		}),
		Button: Button.extend({
			vars: (_theme, props) => ({ root: sized('--button-height', BUTTON_HEIGHT, props.size) }),
			styles: { label: CJK_SAFE_LABEL },
		}),
		Input: Input.extend({
			vars: (_theme, props) => ({ wrapper: sized('--input-height', INPUT_HEIGHT, props.size) }),
		}),
		InputWrapper: InputWrapper.extend({
			styles: { label: { fontWeight: 500, marginBottom: 4 } },
		}),
		ThemeIcon: ThemeIcon.extend({
			vars: (_theme, props) => ({ root: sized('--ti-size', THEME_ICON_SIZE, props.size, 'md') }),
		}),
		Badge: Badge.extend({
			defaultProps: { radius: 'xl', variant: 'light' },
			vars: (_theme, props) => ({
				root: {
					...sized('--badge-height', BADGE_HEIGHT, props.size, 'md'),
					...sized('--badge-fz', BADGE_FONT_SIZE, props.size, 'md'),
				},
			}),
			styles: { root: { textTransform: 'none', fontWeight: 500 }, label: CJK_SAFE_LABEL },
		}),
		Pill: Pill.extend({
			defaultProps: { radius: 'sm' },
			styles: { label: CJK_SAFE_LABEL },
		}),
		Chip: Chip.extend({ styles: { label: CJK_SAFE_LABEL } }),
		Tabs: Tabs.extend({ styles: { tabLabel: CJK_SAFE_LABEL } }),
		// Body copy is 13px; `md` (14px) stays available for emphasis.
		Text: Text.extend({ defaultProps: { size: 'sm' } }),
		Paper: Paper.extend({ defaultProps: { radius: 'md' } }),
		Card: Card.extend({ defaultProps: { radius: 'md', padding: 'md' } }),
		SegmentedControl: SegmentedControl.extend({ defaultProps: { radius: 'sm' } }),
		// Floating layers are the only surfaces with depth.
		Menu: Menu.extend({ defaultProps: { radius: 'md', shadow: 'md' } }),
		Popover: Popover.extend({ defaultProps: { radius: 'md', shadow: 'md' } }),
		HoverCard: HoverCard.extend({ defaultProps: { radius: 'md', shadow: 'md' } }),
		Tooltip: Tooltip.extend({ defaultProps: { radius: 'sm' } }),
		Modal: Modal.extend({
			defaultProps: {
				radius: 'lg',
				shadow: 'xl',
				overlayProps: { backgroundOpacity: 0.48, blur: 2 },
			},
		}),
		Notification: Notification.extend({ defaultProps: { radius: 'md' } }),
	},
})
