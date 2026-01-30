import { Text } from '@mantine/core'
import { FieldChrome } from '../shared'
import { cleanProps } from '../../utils/propHelpers'
import { normalizeErrorMessages, type RendererProps } from './types'

export function UnknownField(props: RendererProps) {
	const { node, errors } = props
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
				该字段类型暂不支持渲染（{node.kind}）
			</Text>
		</FieldChrome>
	)
}
