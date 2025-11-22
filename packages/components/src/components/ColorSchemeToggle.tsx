import {
	ActionIcon,
	type ActionIconProps,
	Tooltip,
	useComputedColorScheme,
	useMantineColorScheme,
} from '@mantine/core'
import { IconMoonStars, IconSun } from '@tabler/icons-react'

export interface ColorSchemeToggleProps
	extends Omit<ActionIconProps, 'children' | 'onClick' | 'variant'> {
	label?: string
}

export function ColorSchemeToggle({
	label = '切换明暗主题',
	...props
}: ColorSchemeToggleProps) {
	const { setColorScheme } = useMantineColorScheme()
	const computed = useComputedColorScheme('light', { getInitialValueInEffect: true })

	const toggle = () => {
		setColorScheme(computed === 'dark' ? 'light' : 'dark')
	}

	const icon = computed === 'dark' ? <IconSun size={18} /> : <IconMoonStars size={18} />
	const tooltip = computed === 'dark' ? '切换至浅色模式' : '切换至深色模式'

	return (
		<Tooltip label={tooltip}>
			<ActionIcon
				variant="default"
				size="lg"
				radius="xl"
				onClick={toggle}
				aria-label={label}
				{...props}
			>
				{icon}
			</ActionIcon>
		</Tooltip>
	)
}
