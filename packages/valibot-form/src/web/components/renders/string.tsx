import { TextInput, Textarea } from '@mantine/core'
import type { StringFieldNode } from '../../../core/fields'
import { FieldChrome } from '../chrome/FieldChrome'
import { cleanProps } from '../../utils/propHelpers'
import { normalizeErrorMessages, type RendererProps, triggerFormEvents } from './types'

export function StringField(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const info = node as StringFieldNode
	const { control, placeholder, minLength, maxLength, rows = 3 } = info
	const isCode = control === 'code'
	const baseErrors = normalizeErrorMessages(errors)

	const inputNode =
		control === 'textarea' || control === 'code' ? (
			<Textarea
				value={typeof value === 'string' ? value : value == null ? '' : String(value)}
				{...cleanProps({
					onChange: (event: React.ChangeEvent<HTMLTextAreaElement>) =>
						triggerFormEvents(inputProps, event.target.value),
					onBlur: inputProps.onBlur,
					name: inputProps.name,
					placeholder,
					minRows: rows,
					autosize: true,
					minLength,
					maxLength,
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
				})}
				styles={
					isCode ? { input: { fontFamily: 'var(--mantine-font-family-monospace)' } } : undefined
				}
			/>
		) : (
			<TextInput
				value={typeof value === 'string' ? value : value == null ? '' : String(value)}
				{...cleanProps({
					onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
						triggerFormEvents(inputProps, event.target.value),
					onBlur: inputProps.onBlur,
					name: inputProps.name,
					placeholder,
					minLength,
					maxLength,
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
					type: control === 'password' ? 'password' : 'text',
				})}
			/>
		)

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
			{inputNode}
		</FieldChrome>
	)
}
