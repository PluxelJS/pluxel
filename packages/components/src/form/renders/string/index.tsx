// src/forms/renderers/string.tsx
import { ColorInput, TextInput } from '@mantine/core'
import { META_MAP, registerRenderer, triggerFormEvents } from 'valibot-form'

registerRenderer(META_MAP.STRING, (props) => {
	const { formBaseInfo, error, extractedPropsInfo, inputProps, value } = props

	// hex_color 格式，直接交给 HexColorField 处理
	if (extractedPropsInfo.format === 'hex_color') {
		return (
			<ColorInput
				label={formBaseInfo.title}
				required={formBaseInfo.required}
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
			label={formBaseInfo.title}
			required={formBaseInfo.required}
			error={error}
			defaultValue={value}
			onChange={(event) => {
				triggerFormEvents(inputProps, event.currentTarget.value)
			}}
			placeholder={extractedPropsInfo.placeholder}
			type={
				extractedPropsInfo.secret
					? 'password'
					: extractedPropsInfo.format === 'email'
						? 'email'
						: 'text'
			}
		/>
	)
})
