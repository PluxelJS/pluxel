import { SegmentedControl, Stack, Text } from '@mantine/core'
import { type ReactNode, useMemo } from 'react'

export type SegmentedButtonOption = {
	value: string
	label: ReactNode
	description?: ReactNode
	disabled?: boolean
}

export interface SegmentedButtonsProps {
	data: Array<string | SegmentedButtonOption>
	value?: string | null
	onChange?: (value: string) => void
	onBlur?: () => void
	disabled?: boolean
	fullWidth?: boolean
	size?: 'xs' | 'sm' | 'md'
}

function normalizeOption(option: string | SegmentedButtonOption): SegmentedButtonOption {
	if (typeof option === 'string') {
		return { value: option, label: option }
	}
	return option
}

function renderLabel(option: SegmentedButtonOption) {
	if (!option.description) return option.label

	return (
		<Stack gap={1} align="center">
			<Text component="span" fw={600} ta="center" lh={1.2}>
				{option.label}
			</Text>
			<Text component="span" size="10px" c="dimmed" ta="center" lh={1.2}>
				{option.description}
			</Text>
		</Stack>
	)
}

export function SegmentedButtons({
	data,
	value,
	onChange,
	onBlur,
	disabled = false,
	fullWidth = false,
	size = 'sm',
}: SegmentedButtonsProps) {
	const options = useMemo(
		() =>
			data.map(normalizeOption).map((option) => ({
				value: option.value,
				label: renderLabel(option),
				disabled: option.disabled,
			})),
		[data],
	)

	if (options.length === 0) return null

	return (
		<SegmentedControl
			data={options}
			value={value ?? undefined}
			onChange={onChange}
			onBlur={onBlur}
			disabled={disabled}
			fullWidth={fullWidth}
			size={size}
		/>
	)
}
