import {
	Box,
	Group,
	InputWrapper,
	NumberInput,
	Slider,
	Stack,
} from '@mantine/core'
import { useState } from 'react'
import { MetaType, registerRenderer, triggerFormEvents } from 'valibot-form'

registerRenderer(
	MetaType.NUMBER,
	({ options, formInfo, value, error, inputProps }) => {
		// slider 模式
		if (options.type === 'slider') {
			const { min = 0, max = 100, step = 1, marks } = options.options

			return (
				<InputWrapper
					label={formInfo.title}
					required={formInfo.required}
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
		const { formatOptions, step, min, max } = options.options

		return (
			<NumberInput
				label={formInfo.title}
				required={formInfo.required}
				error={error}
				defaultValue={value}
				min={min}
				max={max}
				step={step}
				onChange={(val) => {
					if (typeof val === 'number') {
						triggerFormEvents(inputProps, val)
					}
				}}
			/>
		)
	},
)
