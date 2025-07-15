// src/forms/renderers/boolean.tsx
import { InputWrapper, Switch } from '@mantine/core'
import { MetaType, registerRenderer, triggerFormEvents } from 'valibot-form'

registerRenderer(MetaType.BOOLEAN, ({ formInfo, value, error, inputProps }) => {
	return (
		<InputWrapper
			id={inputProps.name}
			label={formInfo.title}
			required={formInfo.required}
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
