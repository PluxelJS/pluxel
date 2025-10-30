import { Box, InputWrapper, NumberInput, Slider } from '@mantine/core'
import { registerRenderer, triggerFormEvents } from '~/registry'
import { META_MAP } from '~/utils'

registerRenderer(META_MAP.NUMBER, (props) => {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const error = errors?.map((e) => e.message).join(', ')
	// slider 模式
	if (extractedPropsInfo.type === 'slider') {
		const { min = 0, max = 100, step = 1, marks } = extractedPropsInfo.options

		return (
			<InputWrapper
				label={formBaseInfo.title}
				required={formBaseInfo.required}
				error={error}
				description="测试"
			>
				<Box style={{ width: '100%', paddingBottom: '1.5rem' }}>
					<Slider
						defaultValue={value}
						min={min}
						max={max}
						step={step}
						marks={marks}
						onChange={(val) => {
							triggerFormEvents(inputProps, val)
						}}
					/>
				</Box>
			</InputWrapper>
		)
	}

	// 普通 NumberInput 模式
	const { step, min, max } = extractedPropsInfo.options

	return (
		<NumberInput
			label={formBaseInfo.title}
			required={formBaseInfo.required}
			error={error}
			defaultValue={value}
			min={min}
			max={max}
			step={step}
			onChange={(val) => {
				inputProps.onChange?.(val)

				/* if (typeof val === 'number') {
					triggerFormEvents(inputProps, val)
				} */
			}}
		/>
	)
})
