import { Text } from '@mantine/core'
import { FieldChrome } from '../chrome/FieldChrome'
import { cleanProps } from '../../utils/propHelpers'
import { normalizeErrorMessages, type RendererProps } from './types'

export function UnsupportedField(props: RendererProps) {
	const { node, errors } = props
	if (node.kind !== 'unsupported') return null
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
			<Text size="sm" c="dimmed">
				{node.reason}
			</Text>
		</FieldChrome>
	)
}
