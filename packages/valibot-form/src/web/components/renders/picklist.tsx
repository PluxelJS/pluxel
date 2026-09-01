import type { PicklistFieldNode } from '../../../core/fields'
import { FieldChrome } from '../chrome/FieldChrome'
import { cleanProps } from '../../utils/propHelpers'
import { PicklistControl } from './controls/PicklistControl'
import {
	normalizeErrorMessages,
	type RendererProps,
	triggerFormBlur,
	triggerFormEvents,
} from './types'

export function PicklistField(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const info = node as PicklistFieldNode
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
			<PicklistControl
				meta={{
					options: info.options,
					entries: info.entries,
					labels: info.labels,
					disabled: info.disabled,
					placeholder: info.placeholder,
					searchable: info.searchable,
					clearable: info.clearable,
					max: info.max,
					create: info.create,
					control: info.control ?? 'select',
					multiple: false,
					emptyLabel: info.emptyLabel,
				}}
				value={value}
				onChange={(next) => triggerFormEvents(inputProps, next)}
				onBlur={() => triggerFormBlur(inputProps)}
				disabled={inputProps.disabled || inputProps.readOnly}
				required={node.required}
				ariaLabel={node.meta.label}
			/>
		</FieldChrome>
	)
}
