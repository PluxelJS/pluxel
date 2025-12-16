import {
	ActionIcon,
	Box,
	ColorSwatch,
	Collapse,
	Group,
	Paper,
	rgba,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
	useComputedColorScheme,
	useMantineColorScheme,
	useMantineTheme,
} from '@mantine/core'
import { useLocalStorage } from '@mantine/hooks'
import { IconCheck, IconMoonStars, IconPalette, IconSun, IconSunMoon } from '@tabler/icons-react'
import { useCallback, useState } from 'react'
import {
	COLOR_PRESETS,
	DEFAULT_COLOR_KEY,
	THEME_CHANGE_EVENT,
	THEME_COLOR_STORAGE_KEY,
} from '../theme'

export interface ThemeCustomizerProps {
	/** 紧凑模式：仅显示图标 */
	compact?: boolean
}

export function ThemeCustomizer({ compact = false }: ThemeCustomizerProps) {
	const theme = useMantineTheme()
	const { colorScheme, setColorScheme } = useMantineColorScheme()
	const computed = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const [expanded, setExpanded] = useState(false)

	const [accentColor, setAccentColor] = useLocalStorage<string>({
		key: THEME_COLOR_STORAGE_KEY,
		defaultValue: DEFAULT_COLOR_KEY,
		getInitialValueInEffect: true,
	})

	const handleColorChange = useCallback(
		(key: string) => {
			setAccentColor(key)
			// 触发主题变更事件，让 MantineProvider 响应
			window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: { accentColor: key } }))
		},
		[setAccentColor],
	)

	const handleSchemeChange = useCallback(
		(scheme: 'light' | 'dark' | 'auto') => {
			setColorScheme(scheme)
		},
		[setColorScheme],
	)

	const currentPreset = COLOR_PRESETS.find((p) => p.key === accentColor) ?? COLOR_PRESETS[0]

	const schemeOptions = [
		{ key: 'light', icon: <IconSun size={16} />, label: '浅色' },
		{ key: 'dark', icon: <IconMoonStars size={16} />, label: '深色' },
		{ key: 'auto', icon: <IconSunMoon size={16} />, label: '跟随系统' },
	] as const

	const borderColor =
		computed === 'dark' ? rgba(theme.colors.dark[4], 0.35) : rgba(theme.colors.gray[3], 0.5)

	if (compact) {
		return (
			<Tooltip label="主题设置" position="right">
				<ActionIcon
					variant="light"
					size="lg"
					radius="xl"
					onClick={() => setExpanded((v) => !v)}
					style={{ alignSelf: 'center' }}
				>
					<IconPalette size={18} stroke={1.8} />
				</ActionIcon>
			</Tooltip>
		)
	}

	return (
		<Paper
			radius="lg"
			px="md"
			py="sm"
			styles={{
				root: {
					background:
						computed === 'dark'
							? `linear-gradient(135deg, ${rgba(theme.colors.dark[6], 0.6)}, ${rgba(theme.colors.dark[7], 0.4)})`
							: 'linear-gradient(135deg, rgba(249,250,255,0.95), rgba(242,245,255,0.95))',
					border: `1px solid ${borderColor}`,
					backgroundColor: 'transparent',
				},
			}}
		>
			<Stack gap="sm">
				<Group
					justify="space-between"
					align="center"
					onClick={() => setExpanded((v) => !v)}
					style={{ cursor: 'pointer' }}
				>
					<Group gap="xs">
						<IconPalette size={16} stroke={1.8} style={{ opacity: 0.7 }} />
						<Text size="xs" fw={600}>
							主题设置
						</Text>
					</Group>
					<ColorSwatch color={currentPreset.color} size={16} />
				</Group>

				<Collapse in={expanded}>
					<Stack gap="sm" pt="xs">
						{/* 颜色模式切换 */}
						<Box>
							<Text size="xs" c="dimmed" mb={6}>
								外观模式
							</Text>
							<Group gap={6}>
								{schemeOptions.map((option) => (
									<Tooltip key={option.key} label={option.label}>
										<ActionIcon
											variant={colorScheme === option.key ? 'filled' : 'light'}
											color={colorScheme === option.key ? 'brand' : 'gray'}
											size="md"
											radius="md"
											onClick={() => handleSchemeChange(option.key)}
										>
											{option.icon}
										</ActionIcon>
									</Tooltip>
								))}
							</Group>
						</Box>

						{/* 主题色选择 */}
						<Box>
							<Text size="xs" c="dimmed" mb={6}>
								主题色
							</Text>
							<ScrollArea.Autosize maw="100%" type="never">
								<Group gap={6} wrap="wrap">
									{COLOR_PRESETS.map((preset) => (
										<Tooltip key={preset.key} label={preset.name}>
											<ActionIcon
												variant="light"
												size="md"
												radius="md"
												onClick={() => handleColorChange(preset.key)}
												style={{
													background:
														accentColor === preset.key ? rgba(preset.color, 0.2) : undefined,
													border:
														accentColor === preset.key
															? `2px solid ${preset.color}`
															: '2px solid transparent',
												}}
											>
												{accentColor === preset.key ? (
													<IconCheck size={14} color={preset.color} />
												) : (
													<ColorSwatch color={preset.color} size={14} withShadow={false} />
												)}
											</ActionIcon>
										</Tooltip>
									))}
								</Group>
							</ScrollArea.Autosize>
						</Box>
					</Stack>
				</Collapse>
			</Stack>
		</Paper>
	)
}
