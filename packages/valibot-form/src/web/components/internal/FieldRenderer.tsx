import type { FieldNode } from '../../../core/fields'
import { ArrayField } from '../renders/array'
import { BooleanField } from '../renders/boolean'
import { NumberField } from '../renders/number'
import { ObjectField } from '../renders/object'
import { PicklistField } from '../renders/picklist'
import { RecordField } from '../renders/record'
import { StringField } from '../renders/string'
import { UnionField } from '../renders/union'
import { UnknownField } from '../renders/unknown'
import type { RendererProps } from '../renders/types'

export function FieldRenderer(props: RendererProps) {
	const { node } = props
	switch (node.kind) {
		case 'string':
			return <StringField {...props} />
		case 'number':
			return <NumberField {...props} />
		case 'boolean':
			return <BooleanField {...props} />
		case 'picklist':
			return <PicklistField {...props} />
		case 'array':
			return <ArrayField {...props} />
		case 'record':
			return <RecordField {...props} />
		case 'object':
			return <ObjectField {...props} />
		case 'union':
			return <UnionField {...props} />
		default:
			return <UnknownField {...props} />
	}
}

export type { RendererProps, FieldNode }
