import { useEffect, useId, useMemo, useRef } from 'react'
import type { FieldNode } from '../../../../core/fields'
import { useValueRenderer } from '../../internal/fieldRendererContext'

/** An unconfirmed collection value has no registered form path. */
export function PendingScalar({
	node,
	value,
	onChange,
	onConfirm,
	focusKey,
}: {
	node: FieldNode
	value: unknown
	onChange: (value: unknown) => void
	onConfirm: () => void
	focusKey?: number
}) {
	const renderValue = useValueRenderer()
	const id = useId()
	const root = useRef<HTMLDivElement>(null)
	const confirm = useRef(onConfirm)
	confirm.current = onConfirm
	useEffect(() => {
		if (focusKey === undefined) return undefined
		const frame = requestAnimationFrame(() => {
			root.current?.querySelector<HTMLElement>('input, textarea, button')?.focus({
				preventScroll: true,
			})
		})
		return () => cancelAnimationFrame(frame)
	}, [focusKey])
	const canConfirmWithEnter = node.kind === 'string' || node.kind === 'number'
	const control = useMemo(
		() =>
			renderValue({
				node: node.kind === 'picklist' ? { ...node, clearable: true } : node,
				path: [],
				value,
				inputProps: {
					id,
					name: id,
					onChange,
					onKeyDown: canConfirmWithEnter
						? (event) => {
								if (event.key === 'Enter' && event.target instanceof HTMLInputElement) {
									event.preventDefault()
									confirm.current()
								}
							}
						: undefined,
				},
			}),
		[canConfirmWithEnter, id, node, onChange, renderValue, value],
	)
	return (
		<div ref={root} role="group" aria-label="新增项">
			{control}
		</div>
	)
}
