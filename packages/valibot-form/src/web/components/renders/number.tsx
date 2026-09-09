import { NumberInput } from '@mantine/core'
import type { NumberFieldNode } from '../../../core/fields'
import { FieldChrome } from '../chrome/FieldChrome'
import { cleanProps } from '../../utils/propHelpers'
import { normalizeErrorMessages, type RendererProps, triggerFormEvents } from './types'

export function NumberField(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const info = node as NumberFieldNode
	const baseErrors = normalizeErrorMessages(errors)
	const parsed =
		typeof value === 'number' ? value : value == null || value === '' ? '' : Number(value)
	const currentValue = Number.isNaN(parsed) ? '' : parsed

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
				errorId: inputProps.errorId,
				hideLabel: node.meta.hideLabel,
				hideRequired: node.meta.hideRequired,
			})}
		>
			<NumberInput
				value={currentValue}
				{...cleanProps({
					onChange: (val: number | string) => {
						const parsedValue = val === '' || val === undefined ? undefined : Number(val)
						const safe = Number.isNaN(parsedValue) ? undefined : parsedValue
						triggerFormEvents(inputProps, safe)
					},
					onBlur: inputProps.onBlur,
					name: inputProps.name,
					id: inputProps.id,
					error: inputProps['aria-invalid'],
					attributes: {
						input: {
							'aria-invalid': inputProps['aria-invalid'],
							'aria-describedby': inputProps['aria-describedby'],
						},
					},
					placeholder: info.placeholder,
					min: info.min,
					max: info.max,
					step: info.step ?? (info.integer ? 1 : undefined),
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
					'aria-label': node.meta.label,
				})}
			/>
		</FieldChrome>
	)
}
