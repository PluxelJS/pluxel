// src/forms/renderers/boolean.tsx
import { InputWrapper, Switch } from '@mantine/core'
import { META_MAP, registerRenderer, triggerFormEvents } from 'valibot-form'

registerRenderer(META_MAP.BOOLEAN, (props) => {
	const { formBaseInfo, error, extractedPropsInfo, inputProps, value } = props
	return (
		<InputWrapper
			id={inputProps.name}
			label={formBaseInfo.title}
			required={formBaseInfo.required}
			error={error}
		>
			<Switch
				{...inputProps}
				defaultChecked={value}
				onChange={(event) => {
					triggerFormEvents(inputProps, event.currentTarget.checked)
				}}
				size="sm"
				aria-invalid={!!error}
			/>
		</InputWrapper>
	)
})
