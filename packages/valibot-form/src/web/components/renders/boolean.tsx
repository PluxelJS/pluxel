import { Switch } from '@mantine/core'
import { FieldChrome } from '../chrome/FieldChrome'
import { cleanProps } from '../../utils/propHelpers'
import { normalizeErrorMessages, type RendererProps, triggerFormEvents } from './types'

export function BooleanField(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const baseErrors = normalizeErrorMessages(errors)

	return (
		<FieldChrome
			{...cleanProps({
				label: node.meta.label,
				required: node.required,
				description: node.meta.description,
				help: node.meta.help,
				hint: node.meta.hint,
				badge: node.meta.badge,
				errors: baseErrors,
				hideLabel: node.meta.hideLabel,
				hideRequired: node.meta.hideRequired,
			})}
		>
			<Switch
				checked={Boolean(value)}
				{...cleanProps({
					onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
						triggerFormEvents(inputProps, event.currentTarget.checked),
					onBlur: inputProps.onBlur,
					name: inputProps.name,
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
					'aria-label': node.meta.label,
				})}
			/>
		</FieldChrome>
	)
}
