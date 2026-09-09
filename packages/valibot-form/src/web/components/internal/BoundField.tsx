import { memo, useContext, useId, type ReactNode } from 'react'
import type { AnyFieldApi } from '@tanstack/react-form'
import type { FieldNode } from '../../../core/fields'
import { FormResetVersion, useAutoFormCtx } from './formContext'
import type { FieldError, RendererProps } from '../renders/types'
import { FieldRenderer } from './FieldRenderer'
import { UnionSelectionContext } from './unionSelectionContext'
import { fieldName, readPath, writePath, type FieldPath } from './fieldPath'

export interface BoundFieldProps {
	node: FieldNode
	path: FieldPath
	disabled?: boolean
	readOnly?: boolean
	/** Structural controls such as a union discriminator own their transition. */
	onChange?: (value: unknown) => void
	children?: (props: RendererProps) => ReactNode
}

function BoundFieldImpl(props: BoundFieldProps) {
	const { form } = useAutoFormCtx()
	if (props.node.meta.hidden) return null
	const name = fieldName(props.path)
	if (name === undefined) return <LiteralField {...props} />
	return (
		<form.Field
			name={name}
			mode={
				props.node.kind === 'array' &&
				!(props.node.layout === 'picker' && props.node.item?.kind === 'picklist')
					? 'array'
					: 'value'
			}
		>
			{(field) => <BoundControl {...props} field={field} />}
		</form.Field>
	)
}

export const BoundField = memo(
	BoundFieldImpl,
	(a, b) =>
		a.node === b.node &&
		a.disabled === b.disabled &&
		a.readOnly === b.readOnly &&
		a.onChange === b.onChange &&
		a.children === b.children &&
		a.path.length === b.path.length &&
		a.path.every((part, index) => part === b.path[index]),
)

function BoundControl({ field, ...props }: BoundFieldProps & { field: AnyFieldApi }) {
	const resetVersion = useContext(FormResetVersion)
	const initializeUnion = useContext(UnionSelectionContext)
	const id = useId()
	const { node, path, children } = props
	const disabled = Boolean(props.disabled || node.meta.disabled)
	const readOnly = Boolean(props.readOnly || node.meta.readOnly)
	const errors = field.state.meta.errors as FieldError[]
	const locked = disabled || readOnly
	const beforeChange = () => {
		initializeUnion?.()
		if (field.state.meta.errorMap.onServer !== undefined) {
			field.setMeta((meta) => ({
				...meta,
				errorMap: { ...meta.errorMap, onServer: undefined },
			}))
		}
	}
	const rendererProps: RendererProps = {
		node,
		path,
		resetVersion,
		value: field.state.value,
		errors,
		inputProps: {
			name: field.name,
			id,
			errorId: `${id}-errors`,
			'aria-invalid': errors.length > 0,
			'aria-describedby': errors.length > 0 ? `${id}-errors` : undefined,
			disabled,
			readOnly,
			onChange: (value) => {
				if (locked) return
				beforeChange()
				;(props.onChange ?? field.handleChange)(value)
			},
			onBlur: () => {
				if (!locked) field.handleBlur()
			},
		},
		arrayActions: {
			push: (value) => {
				if (!locked) {
					beforeChange()
					field.pushValue(value)
				}
			},
			remove: (index) => {
				if (!locked) {
					beforeChange()
					void field.removeValue(index)
				}
			},
			move: (from, to) => {
				if (!locked) {
					beforeChange()
					field.moveValue(from, to)
				}
			},
		},
	}
	return children ? children(rendererProps) : <FieldRenderer {...rendererProps} />
}

/**
 * TanStack's string paths cannot address keys such as "a.b" or "0" literally.
 * Keep these values in the same form store, updating the closest representable
 * ancestor. Do not register a misleading field name; server issues use the summary.
 */
function LiteralField(props: BoundFieldProps) {
	const { form } = useAutoFormCtx()
	const resetVersion = useContext(FormResetVersion)
	const initializeUnion = useContext(UnionSelectionContext)
	const id = useId()
	let prefixLength = props.path.length - 1
	while (prefixLength > 0 && fieldName(props.path.slice(0, prefixLength)) === undefined)
		prefixLength--
	const ancestor = fieldName(props.path.slice(0, prefixLength))
	const tail = props.path.slice(prefixLength)
	const disabled = Boolean(props.disabled || props.node.meta.disabled)
	const readOnly = ancestor === undefined || Boolean(props.readOnly || props.node.meta.readOnly)
	const locked = disabled || readOnly
	const update = (next: unknown) => {
		if (locked || ancestor === undefined) return
		initializeUnion?.()
		if (form.getFieldMeta(ancestor)?.errorMap.onServer !== undefined) {
			form.setFieldMeta(ancestor, (meta) => ({
				...meta,
				errorMap: { ...meta.errorMap, onServer: undefined },
			}))
		}
		if (props.onChange) {
			props.onChange(next)
			return
		}
		// Literal descendants share their representable ancestor’s atomic value boundary.
		form.setFieldValue(ancestor, (previous: unknown) => writePath(previous, tail, next))
	}
	return (
		<form.Subscribe selector={(state) => readPath(state.values, props.path)}>
			{(value) => {
				const items = Array.isArray(value) ? value : []
				const rendererProps: RendererProps = {
					// Without an addressable ancestor, preserve the value and explain why
					// editing is unavailable; never invent a root path or change its shape.
					node:
						ancestor === undefined
							? {
									...props.node,
									kind: 'unsupported',
									readOnly: true,
									reason:
										'此顶层字段名无法通过表单路径表示。请重命名字段，或将它放入普通命名的对象或记录中再编辑。',
								}
							: props.node,
					path: props.path,
					resetVersion,
					value,
					errors: [],
					inputProps: {
						name: id,
						id,
						errorId: `${id}-errors`,
						disabled,
						readOnly,
						onChange: update,
						onBlur: () => {
							if (locked || ancestor === undefined) return
							const field = form.getFieldInfo(ancestor).instance
							if (field && 'handleBlur' in field) (field as AnyFieldApi).handleBlur()
						},
					},
					arrayActions: {
						push: (item) => update([...items, item]),
						remove: (index) => update(items.filter((_, i) => i !== index)),
						move: (from, to) => {
							const next = [...items]
							next.splice(to, 0, next.splice(from, 1)[0])
							update(next)
						},
					},
				}
				return ancestor !== undefined && props.children ? (
					props.children(rendererProps)
				) : (
					<FieldRenderer {...rendererProps} />
				)
			}}
		</form.Subscribe>
	)
}
