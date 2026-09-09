import type { FieldNode } from '../../../core/fields'

export function tweakNestedNode(node: FieldNode): FieldNode {
	const baseMeta = { ...node.meta, hideLabel: true, hideRequired: true }
	switch (node.kind) {
		case 'object':
			return {
				...node,
				meta: baseMeta,
				variant: 'stack',
				gap: 'sm',
				columns: node.columns ?? 2,
			}
		case 'array':
			return { ...node, meta: baseMeta, disableAutoGrid: true }
		case 'union':
			return { ...node, meta: baseMeta, compact: true }
		default:
			return { ...node, meta: baseMeta }
	}
}
