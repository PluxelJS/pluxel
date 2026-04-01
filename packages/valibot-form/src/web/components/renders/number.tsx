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
				hideLabel: node.meta.hideLabel,
				hideRequired: node.meta.hideRequired,
			})}
		>
			<NumberInput
				value={currentValue}
				{...cleanProps({
					onChange: (val: number | string) => {
						const parsed = val === '' || val === undefined ? undefined : Number(val)
						const safe = Number.isNaN(parsed) ? undefined : parsed
						triggerFormEvents(inputProps, safe)
					},
					onBlur: inputProps.onBlur,
					name: inputProps.name,
					placeholder: info.placeholder,
					min: info.min,
					max: info.max,
					step: info.step ?? (info.integer ? 1 : undefined),
					disabled: inputProps.disabled,
					readOnly: inputProps.readOnly,
				})}
			/>
		</FieldChrome>
	)
}
