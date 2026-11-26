import { FieldChrome } from '../chrome/FieldChrome'
import { cleanProps } from '../../utils/propHelpers'
import { PicklistControl } from './controls/PicklistControl'
import {
	normalizeErrorMessages,
	type ScalarRendererProps,
	triggerFormBlur,
	triggerFormEvents,
} from './types'

export function PicklistField(props: ScalarRendererProps<'picklist'>) {
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
				errorId: inputProps.errorId,
				descriptionId: inputProps.descriptionId,
				hideLabel: node.meta.hideLabel,
				hideRequired: node.meta.hideRequired,
			})}
		>
			<PicklistControl
				id={inputProps.id}
				name={inputProps.name}
				aria-invalid={inputProps['aria-invalid']}
				aria-describedby={inputProps['aria-describedby']}
				node={node}
				value={value}
				onChange={(next) => triggerFormEvents(inputProps, next ?? undefined)}
				onBlur={() => triggerFormBlur(inputProps)}
				disabled={inputProps.disabled || inputProps.readOnly}
				required={node.required}
				ariaLabel={node.meta.label}
			/>
		</FieldChrome>
	)
}
