import {
	ActionIcon,
	type ActionIconProps,
	Box,
	ColorSwatch,
	Collapse,
	Group,
	Paper,
	Popover,
	rgba,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
	useComputedColorScheme,
	useMantineColorScheme,
} from '@mantine/core'
import { IconCheck, IconMoonStars, IconPalette, IconSun } from '@tabler/icons-react'
import { useCallback, useState } from 'react'
import { SegmentedButtons } from 'valibot-form/web'
import { useThemeColorKey } from './runtime'

export interface ColorSchemeToggleProps
	extends Omit<ActionIconProps, 'children' | 'onClick'> {
	label?: string
}

export function ColorSchemeToggle({
	label = '切换明暗主题',
	variant = 'default',
	size = 'lg',
	radius = 'xl',
	...props
}: ColorSchemeToggleProps) {
	const { setColorScheme } = useMantineColorScheme()
	const computed = useComputedColorScheme('light', { getInitialValueInEffect: true })

	const toggle = () => {
		setColorScheme(computed === 'dark' ? 'light' : 'dark')
	}

	return (
		<Tooltip label={computed === 'dark' ? '切换至浅色模式' : '切换至深色模式'}>
			<ActionIcon
				variant={variant}
				size={size}
				radius={radius}
				onClick={toggle}
				aria-label={label}
				{...props}
			>
				{computed === 'dark' ? <IconSun size={18} /> : <IconMoonStars size={18} />}
			</ActionIcon>
		</Tooltip>
	)
}

export interface ThemeCustomizerProps {
	compact?: boolean
}

export function ThemeCustomizer({ compact = false }: ThemeCustomizerProps) {
	const computed = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const { setColorScheme } = useMantineColorScheme()
	const [expanded, setExpanded] = useState(false)
	const [opened, setOpened] = useState(false)
	const { colorKey: accentColor, setThemeColor, presets } = useThemeColorKey()

	const handleColorChange = useCallback(
		(key: string) => {
			setThemeColor(key)
		},
		[setThemeColor],
	)

	const currentPreset = presets.find((preset) => preset.key === accentColor) ?? presets[0]
	const schemeControl = (
		<Box>
			<Text size="xs" c="dimmed" mb={6}>
				明暗模式
			</Text>
			<SegmentedButtons
				fullWidth
				size="xs"
				value={computed}
				onChange={(value) => setColorScheme(value as 'light' | 'dark')}
				data={[
					{ value: 'light', label: '浅色' },
					{ value: 'dark', label: '深色' },
				]}
			/>
		</Box>
	)
	const accentPicker = (
		<Box>
			{compact ? null : (
				<Text size="xs" c="dimmed" mb={6}>
					主题色
				</Text>
			)}
			<ScrollArea.Autosize maw={compact ? 260 : '100%'} type="never">
				<Group gap={6} wrap="wrap">
					{presets.map((preset) => (
						<Tooltip key={preset.key} label={preset.name}>
							<ActionIcon
								variant="light"
								size="md"
								radius="md"
								onClick={() => handleColorChange(preset.key)}
								style={{
									background: accentColor === preset.key ? rgba(preset.color, 0.2) : undefined,
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
	)

	if (compact) {
		return (
			<Popover
				withArrow
				shadow="md"
				position="right"
				offset={10}
				opened={opened}
				onChange={setOpened}
			>
				<Popover.Target>
					<Tooltip label="主题设置" position="right" openDelay={300}>
						<ActionIcon
							variant="light"
							size="lg"
							radius="xl"
							style={{ alignSelf: 'center' }}
							aria-label="主题设置"
							onClick={() => setOpened((value) => !value)}
						>
							<IconPalette size={18} stroke={1.8} />
						</ActionIcon>
					</Tooltip>
				</Popover.Target>
				<Popover.Dropdown
					p="sm"
					style={{
						background: 'var(--plx-panel-bg)',
						border: '1px solid var(--plx-panel-border-strong)',
						boxShadow: 'var(--plx-shadow)',
					}}
				>
					<Stack gap="sm">
						<Group justify="space-between" align="center">
							<Group gap="xs">
								<IconPalette size={16} stroke={1.8} style={{ opacity: 0.7 }} />
								<Text size="xs" fw={600}>
									主题设置
								</Text>
							</Group>
							<ColorSwatch color={currentPreset.color} size={16} />
						</Group>

						{schemeControl}
						{accentPicker}
					</Stack>
				</Popover.Dropdown>
			</Popover>
		)
	}

	return (
		<Paper
			radius="lg"
			px="md"
			py="sm"
			styles={{
				root: {
					background: 'var(--plx-panel-bg)',
					border: '1px solid var(--plx-panel-border-strong)',
					boxShadow: 'var(--plx-shadow)',
				},
			}}
		>
			<Stack gap="sm">
				<Group
					justify="space-between"
					align="center"
					onClick={() => setExpanded((value) => !value)}
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
						{schemeControl}
						{accentPicker}
					</Stack>
				</Collapse>
			</Stack>
		</Paper>
	)
}
