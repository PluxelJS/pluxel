import type { FieldNode } from '../../../core/fields'
import type { InputProps } from './types'

export function tweakNestedNode(node: FieldNode): FieldNode {
	const baseMeta = { ...node.meta, hideLabel: true, hideRequired: true }
	switch (node.kind) {
		case 'object':
			return {
				...node,
				meta: baseMeta,
				variant: 'stack',
				gap: 'sm',
				columns: (node as any).columns ?? 2,
			}
		case 'array':
			return { ...node, meta: baseMeta, disableAutoGrid: true }
		case 'union':
			return { ...node, meta: baseMeta, compact: true }
		default:
			return { ...node, meta: baseMeta }
	}
}

export function buildNestedInputProps(
	parent: InputProps,
	name: string,
	onChange: (value: unknown) => void,
): InputProps {
	return {
		name,
		onChange,
		onBlur: () => parent.onBlur?.({ target: { name } } as any),
		disabled: parent.disabled,
		readOnly: parent.readOnly,
	}
}
