// src/forms/renderers/string.tsx
import { ColorInput, TextInput } from '@mantine/core'
import { MetaType, registerRenderer, triggerFormEvents } from 'valibot-form'

registerRenderer(MetaType.STRING, (props) => {
	const { options, value, formInfo, error, inputProps } = props

	// hex_color 格式，直接交给 HexColorField 处理
	if (options.format === 'hex_color') {
		return (
			<ColorInput
				label={formInfo.title}
				required={formInfo.required}
				error={error}
				defaultValue={value}
				onChangeEnd={(value) => {
					triggerFormEvents(inputProps, value)
				}}
			/>
		)
	}

	// 普通文本/邮箱/密码输入
	return (
		<TextInput
			{...inputProps}
			label={formInfo.title}
			required={formInfo.required}
			error={error}
			defaultValue={value}
			onChange={(event) => {
				triggerFormEvents(inputProps, event.currentTarget.value)
			}}
			placeholder={options.placeholder}
			type={
				options.secret
					? 'password'
					: options.format === 'email'
						? 'email'
						: 'text'
			}
		/>
	)
})
