import { Button, Group, Text } from '@mantine/core'
import { useContext } from 'react'
import type { FieldNode } from '../../../core/fields'
import { ArrayField } from '../renders/array'
import { BooleanField } from '../renders/boolean'
import { NumberField } from '../renders/number'
import { ObjectField } from '../renders/object'
import { PicklistField } from '../renders/picklist'
import { RecordField } from '../renders/record'
import { StringField } from '../renders/string'
import { UnionField } from '../renders/union'
import { UnsupportedField } from '../renders/unsupported'
import { triggerFormEvents, type RendererProps, type ScalarRenderers } from '../renders/types'
import { hasProtectedValue } from './fieldProtection'
import { ScalarRenderersContext } from './fieldRendererContext'

export const webRenderers = Object.freeze({
	string: StringField,
	number: NumberField,
	boolean: BooleanField,
	picklist: PicklistField,
})

export function FieldRenderer(props: RendererProps) {
	const renderers = useContext(ScalarRenderersContext)
	const control = renderControl(props, renderers)
	const { node, value, inputProps } = props
	const writable = !inputProps.readOnly && !inputProps.disabled && node.kind !== 'unsupported'
	const canSetNull = writable && node.nullable && value !== null && !hasProtectedValue(node, value)
	const empty = writable && value == null ? emptyValue(node) : undefined
	return (
		<>
			{control}
			{canSetNull || empty !== undefined || value === null ? (
				<Group gap="xs" mt="xs">
					{value === null ? (
						<Text size="xs" c="dimmed">
							当前输入为 null
						</Text>
					) : null}
					{canSetNull ? (
						<Button
							type="button"
							variant="subtle"
							size="compact-xs"
							aria-label={`${node.meta.label} · 设为 null`}
							onClick={() => triggerFormEvents(inputProps, null, { blur: true })}
						>
							设为 null
						</Button>
					) : null}
					{empty !== undefined ? (
						<Button
							type="button"
							variant="subtle"
							size="compact-xs"
							aria-label={`${node.meta.label} · 设置空值`}
							onClick={() => triggerFormEvents(inputProps, empty, { blur: true })}
						>
							{Array.isArray(empty) ? '设为空列表' : '设为空对象'}
						</Button>
					) : null}
				</Group>
			) : null}
		</>
	)
}

function emptyValue(node: FieldNode): Record<string, never> | never[] | undefined {
	if (node.kind === 'object' && node.fields.every((field) => !field.required)) return {}
	if (node.kind === 'array' && node.item && !node.min) return []
	if (node.kind === 'record' && node.value && !node.min) return {}
	return undefined
}

function renderControl(props: RendererProps, renderers: ScalarRenderers | undefined) {
	const { node } = props
	switch (node.kind) {
		case 'string': {
			const Control = renderers?.string ?? webRenderers.string
			return <Control {...props} node={node} />
		}
		case 'number': {
			const Control = renderers?.number ?? webRenderers.number
			return <Control {...props} node={node} />
		}
		case 'boolean': {
			const Control = renderers?.boolean ?? webRenderers.boolean
			return <Control {...props} node={node} />
		}
		case 'picklist': {
			const Control = renderers?.picklist ?? webRenderers.picklist
			return <Control {...props} node={node} />
		}
		case 'array':
			return <ArrayField {...props} />
		case 'record':
			return <RecordField {...props} />
		case 'object':
			return <ObjectField {...props} />
		case 'union':
			return <UnionField {...props} />
		case 'unsupported':
			return <UnsupportedField {...props} />
	}
}

export type { RendererProps, FieldNode }
