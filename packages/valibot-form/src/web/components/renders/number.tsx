import { Box, Group, NumberInput, Slider, Text } from '@mantine/core'
import type { CommonProps } from '~/core/registry'
import { registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { FieldChrome } from '../shared'
import { cleanProps } from '../../utils/propHelpers'

type RendererProps = CommonProps<typeof META_MAP.NUMBER> & { value?: unknown }

function NumberField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const errorMessages = (errors ?? []).map((err) => err.message)

	const numericValue = typeof value === 'number' ? value
		: (value == null || value === '') ? undefined
		: (typeof value === 'string' && !isNaN(Number(value))) ? Number(value)
		: undefined

	const variant = extractedPropsInfo.variant ?? 'input'

	const leftSection = extractedPropsInfo.prefix ? (
		<Text size="sm" c="dimmed">{extractedPropsInfo.prefix}</Text>
	) : undefined

	const rightSection = extractedPropsInfo.suffix ? (
		<Text size="sm" c="dimmed">{extractedPropsInfo.suffix}</Text>
	) : undefined

	const numberInput = (
		<NumberInput
			value={numericValue ?? ''}
			onChange={(val) => {
				const next = val === '' || val === undefined ? undefined : Number(val)
				triggerFormEvents(inputProps, next)
			}}
			leftSection={leftSection}
			rightSection={rightSection}
			{...cleanProps({
				min: extractedPropsInfo.min,
				max: extractedPropsInfo.max,
				step: extractedPropsInfo.step,
				disabled: inputProps.disabled,
				readOnly: inputProps.readOnly,
				placeholder: extractedPropsInfo.placeholder,
			})}
		/>
	)

	const slider = (
		<Box style={{ width: '100%' }}>
			<Slider
				value={numericValue ?? extractedPropsInfo.min ?? 0}
				onChange={(val) => triggerFormEvents(inputProps, val)}
				min={extractedPropsInfo.min ?? 0}
				max={extractedPropsInfo.max ?? 100}
				step={extractedPropsInfo.step ?? 1}
				{...cleanProps({
					marks: extractedPropsInfo.marks,
					disabled: inputProps.disabled || inputProps.readOnly,
				})}
			/>
			{(extractedPropsInfo.prefix || extractedPropsInfo.suffix) && (
				<Group justify="space-between" mt={4}>
					{extractedPropsInfo.prefix && (
						<Text size="sm" c="dimmed">{extractedPropsInfo.prefix}</Text>
					)}
					<Text size="sm" fw={600}>
						{numericValue ?? extractedPropsInfo.min ?? 0}
						{extractedPropsInfo.suffix ? ` ${extractedPropsInfo.suffix}` : ''}
					</Text>
				</Group>
			)}
		</Box>
	)

	return (
		<FieldChrome
			{...cleanProps({
				label: formBaseInfo.label,
				required: formBaseInfo.required,
				description: formBaseInfo.description,
				helperText: formBaseInfo.helperText,
				hint: formBaseInfo.hint ?? extractedPropsInfo.note,
				tooltip: formBaseInfo.tooltip,
				badge: formBaseInfo.badge,
				errors: errorMessages,
			})}
		>
			{variant === 'slider' ? slider : numberInput}
		</FieldChrome>
	)
}

registerRenderer(META_MAP.NUMBER, (props: any) => <NumberField {...props} />)
