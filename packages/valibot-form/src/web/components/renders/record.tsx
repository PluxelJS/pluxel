import {
	ActionIcon,
	Button,
	Card,
	Group,
	NumberInput,
	Stack,
	Switch,
	Table,
	Text,
	Textarea,
	TextInput,
} from '@mantine/core'
import { IconArrowDown, IconArrowUp, IconPlus, IconTrash } from '@tabler/icons-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { DEFAULT_TEXTS } from '../../../core/constants'
import type {
	FieldNode,
	NumberFieldNode,
	PicklistFieldNode,
	RecordFieldNode,
	StringFieldNode,
} from '../../../core/fields'
import { FieldChrome } from '../chrome/FieldChrome'
import { useFieldRenderer } from '../internal/fieldRendererContext'
import { cleanProps } from '../../utils/propHelpers'
import { PicklistControl } from './controls/PicklistControl'
import {
	joinErrorMessages,
	normalizeErrorMessages,
	type RendererProps,
	toInputString,
	triggerFormBlur,
	triggerFormEvents,
} from './types'
import { tweakNestedNode } from './nested'

type ValueKind = FieldNode['kind'] | 'json' | null

type RecordRow = {
	id: string
	key: string
}

function resolvePicklistDefault(meta?: PicklistFieldNode | null): unknown {
	if (meta?.entries?.length) return meta.entries[0].value
	if (meta?.options?.length) return meta.options[0]
	return ''
}

function resolveDefaultValueForNode(node?: FieldNode | null): unknown {
	if (!node) return ''
	switch (node.kind) {
		case 'string':
			return ''
		case 'number':
			return 0
		case 'boolean':
			return false
		case 'picklist':
			return resolvePicklistDefault(node)
		case 'array':
			return []
		case 'object':
		case 'record':
		case 'union':
			return {}
		default:
			return ''
	}
}

function resolveDefaultValueForKind(
	kind: ValueKind,
	picklistMeta?: PicklistFieldNode | null,
): unknown {
	switch (kind) {
		case 'string':
			return ''
		case 'number':
			return 0
		case 'boolean':
			return false
		case 'picklist':
			return resolvePicklistDefault(picklistMeta)
		case 'array':
			return []
		case 'object':
		case 'record':
		case 'union':
		case 'json':
			return {}
		default:
			return ''
	}
}

function inferValueKind(value: unknown): ValueKind {
	if (typeof value === 'string') return 'string'
	if (typeof value === 'number') return 'number'
	if (typeof value === 'boolean') return 'boolean'
	if (Array.isArray(value)) return 'array'
	if (value && typeof value === 'object') return 'json'
	return null
}

export function RecordField(props: RendererProps) {
	return <RecordFieldEditor key={props.resetVersion} {...props} />
}

function RecordFieldEditor(props: RendererProps) {
	const { node, errors, inputProps, value, path, resetVersion } = props
	const info = node as RecordFieldNode
	const renderField = useFieldRenderer()
	const layout = info.layout ?? 'table'

	const rowIdRef = useRef(0)
	const recordValue = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
	const keys = Object.keys(recordValue)
	// Rows own identity/order only; field values always come from the form store.
	const [rowState, setRows] = useState<RecordRow[]>(() =>
		keys.map((key) => ({ id: `row_${rowIdRef.current++}`, key })),
	)
	const presentKeys = new Set(keys)
	const retainedRows = rowState.filter((row) => presentKeys.has(row.key))
	const retainedKeys = new Set(retainedRows.map((row) => row.key))
	const rows = [
		...retainedRows,
		...keys
			.filter((key) => !retainedKeys.has(key))
			.map((key) => ({
				id: `row_${rowIdRef.current++}`,
				key,
			})),
	]
	if (rows.length !== rowState.length || rows.some((row, index) => row !== rowState[index])) {
		setRows(rows)
	}
	const inferredValueKind = Object.values(recordValue).map(inferValueKind).find(Boolean) ?? null

	const minItems = info.min ?? 0
	const maxItems = info.max
	const isLocked = Boolean(inputProps.disabled || inputProps.readOnly)
	const canAdd =
		info.addable !== false && !isLocked && (maxItems === undefined || rows.length < maxItems)
	const canRemove = info.removable !== false
	const canReorder = info.reorderable !== false && rows.length > 1
	const editableKey = info.editableKey !== false

	const keyLabel = info.key?.label ?? 'Key'
	const valueLabel = info.valueMeta?.label ?? 'Value'
	const keyPlaceholder = info.key?.placeholder
	const valuePlaceholder = info.valueMeta?.placeholder
	const valueNode = info.value ?? null
	const valueKind = valueNode?.kind ?? inferredValueKind
	const valueNumberMeta = valueNode?.kind === 'number' ? (valueNode as NumberFieldNode) : null
	const valueStringMeta = valueNode?.kind === 'string' ? (valueNode as StringFieldNode) : null
	const valuePicklistMeta = valueNode?.kind === 'picklist' ? (valueNode as PicklistFieldNode) : null
	const inlineAddEnabled =
		layout === 'table' &&
		canAdd &&
		!isLocked &&
		editableKey &&
		(valueKind === 'string' ||
			valueKind === 'number' ||
			valueKind === 'boolean' ||
			valueKind === 'picklist')
	const addLabel = info.addLabel ?? (node.meta.label ? `添加${node.meta.label}` : '添加记录')

	const [draftKey, setDraftKey] = useState('')
	const [draftValue, setDraftValue] = useState<unknown>()
	const draftKeyRef = useRef<HTMLInputElement | null>(null)

	useEffect(() => {
		setDraftValue(undefined)
		setDraftKey('')
	}, [valueKind, resetVersion])

	useEffect(() => {
		if (!inlineAddEnabled) return undefined
		const handle = requestAnimationFrame(() => {
			draftKeyRef.current?.focus({ preventScroll: true })
		})
		return () => cancelAnimationFrame(handle)
	}, [inlineAddEnabled, rows.length])

	const baseErrors = normalizeErrorMessages(errors)
	const [jsonErrors, setJsonErrors] = useState<Record<string, string | undefined>>({})

	useEffect(() => {
		setJsonErrors({})
	}, [resetVersion])

	const commitRows = (nextRows: RecordRow[], nextValues = recordValue) => {
		setRows(nextRows)
		triggerFormEvents(
			inputProps,
			Object.fromEntries(nextRows.map((row) => [row.key, nextValues[row.key]])),
			{ blur: true },
		)
	}

	const handleBlur = () => triggerFormBlur(inputProps)

	const existingKeySet = new Set(rows.map((row) => row.key))
	const draftKeyTrimmed = draftKey.trim()
	const draftKeyError =
		draftKeyTrimmed.length === 0 ? null : existingKeySet.has(draftKeyTrimmed) ? 'Key 已存在' : null
	const draftKeyValid = draftKeyTrimmed.length > 0 && !draftKeyError

	useEffect(() => {
		if (!inlineAddEnabled || draftValue !== undefined) return
		const next =
			valueNode != null
				? resolveDefaultValueForNode(valueNode)
				: resolveDefaultValueForKind(valueKind, valuePicklistMeta)
		setDraftValue(next)
	}, [inlineAddEnabled, draftValue, valueKind, valueNode, valuePicklistMeta])

	const resolveDraftValue = () => {
		if (draftValue !== undefined) return draftValue
		if (valueNode) return resolveDefaultValueForNode(valueNode)
		return resolveDefaultValueForKind(valueKind, valuePicklistMeta)
	}

	const handleInlineAdd = () => {
		if (!draftKeyValid || !canAdd || isLocked) return
		commitRows([...rows, { id: `row_${rowIdRef.current++}`, key: draftKeyTrimmed }], {
			...recordValue,
			[draftKeyTrimmed]: resolveDraftValue(),
		})
		setDraftKey('')
		setDraftValue(undefined)
	}

	const handleKeyChange = (index: number, nextKey: string) => {
		const current = rows[index]
		if (!current || isLocked || nextKey === current.key) return
		if (existingKeySet.has(nextKey)) return
		const next = rows.map((row, idx) => (idx === index ? { ...row, key: nextKey } : row))
		commitRows(next, { ...recordValue, [nextKey]: recordValue[current.key] })
	}

	const handleRemove = (index: number) => {
		if (!canRemove || isLocked) return
		if (rows.length <= minItems) return
		const next = rows.filter((_, idx) => idx !== index)
		commitRows(next)
	}

	const handleMove = (index: number, direction: number) => {
		if (!canReorder || isLocked) return
		const target = index + direction
		if (target < 0 || target >= rows.length) return
		const next = [...rows]
		const [removed] = next.splice(index, 1)
		next.splice(target, 0, removed)
		commitRows(next)
	}

	const handleAdd = () => {
		if (!canAdd || isLocked) return
		const baseKey = (keyPlaceholder ?? keyLabel ?? 'key').replaceAll(/\s+/g, '_')
		let index = rows.length + 1
		let nextKey = `${baseKey}_${index}`
		while (existingKeySet.has(nextKey)) {
			index += 1
			nextKey = `${baseKey}_${index}`
		}
		const nextValue = resolveDraftValue()
		const next: RecordRow[] = [...rows, { id: `row_${rowIdRef.current++}`, key: nextKey }]
		commitRows(next, { ...recordValue, [nextKey]: nextValue })
	}

	// Every row of a planned value type shares the same presentation node.
	// Keep that identity stable so editing one value does not rerender all siblings.
	const nestedValueNodes = useMemo(() => {
		const nodes = new Map<string, FieldNode>()
		for (const kind of valueNode ? [valueNode.kind] : ['string', 'number', 'boolean']) {
			const inferredNode =
				valueNode ??
				({
					kind,
					path: '',
					depth: node.depth + 1,
					required: false,
					meta: { label: valueLabel },
					...(kind === 'string' ? { control: 'text' as const } : {}),
					...(kind === 'boolean' ? { control: 'switch' as const } : {}),
				} as FieldNode)
			nodes.set(
				kind,
				tweakNestedNode({
					...inferredNode,
					...(valuePlaceholder ? { placeholder: valuePlaceholder } : {}),
				}),
			)
		}
		return nodes
	}, [valueNode, node.depth, valueLabel, valuePlaceholder])

	const renderValueControl = (current: unknown, row: RecordRow) => {
		const inferredType = valueNode?.kind ?? inferValueKind(current) ?? 'string'
		const childPath = [...path, row.key]
		const nestedNode = nestedValueNodes.get(inferredType)
		if (nestedNode) {
			return renderField({
				node: nestedNode,
				path: childPath,
				disabled: inputProps.disabled,
				readOnly: inputProps.readOnly,
			})
		}
		// A record without a value plan retains a JSON draft until parsing succeeds.
		return renderField({
			node: {
				kind: 'unsupported',
				path: '',
				depth: node.depth + 1,
				required: false,
				meta: { label: valueLabel },
				reason: 'JSON',
				readOnly: true,
			},
			path: childPath,
			disabled: inputProps.disabled,
			readOnly: inputProps.readOnly,
			children: (bound: RendererProps) => {
				const formatted = JSON.stringify(
					bound.value ?? (inferredType === 'array' ? [] : {}),
					null,
					2,
				)
				return (
					<Textarea
						key={`${row.id}:${resetVersion}`}
						id={bound.inputProps.id}
						name={bound.inputProps.name}
						defaultValue={formatted}
						minRows={4}
						autosize
						error={joinErrorMessages([
							...(bound.errors ?? []),
							...(jsonErrors[row.id] ? [jsonErrors[row.id]!] : []),
						])}
						onBlur={(event) => {
							if (isLocked) return
							try {
								triggerFormEvents(
									bound.inputProps,
									JSON.parse(event.currentTarget.value || formatted),
									{ blur: true },
								)
								setJsonErrors((prev) => ({ ...prev, [row.id]: undefined }))
							} catch {
								setJsonErrors((prev) => ({ ...prev, [row.id]: DEFAULT_TEXTS.validation.jsonError }))
							}
						}}
						disabled={inputProps.disabled ?? false}
						readOnly={inputProps.readOnly ?? false}
						styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)' } }}
					/>
				)
			},
		})
	}

	const renderActions = (idx: number) => (
		<Group gap="xs">
			{canReorder ? (
				<>
					<ActionIcon
						variant="subtle"
						onClick={() => handleMove(idx, -1)}
						disabled={idx === 0 || isLocked}
						aria-label="上移"
						type="button"
					>
						<IconArrowUp size={16} />
					</ActionIcon>
					<ActionIcon
						variant="subtle"
						onClick={() => handleMove(idx, 1)}
						disabled={idx === rows.length - 1 || isLocked}
						aria-label="下移"
						type="button"
					>
						<IconArrowDown size={16} />
					</ActionIcon>
				</>
			) : null}
			{canRemove ? (
				<ActionIcon
					variant="subtle"
					color="red"
					onClick={() => handleRemove(idx)}
					disabled={isLocked || rows.length <= minItems}
					aria-label="删除"
					type="button"
				>
					<IconTrash size={16} />
				</ActionIcon>
			) : null}
		</Group>
	)

	const keyWidth = info.key?.width
	const valueWidth = info.valueMeta?.width

	const tableRows = rows.map((row, idx) => (
		<tr key={row.id}>
			<td style={keyWidth ? { width: keyWidth } : undefined}>
				{editableKey ? (
					<TextInput
						value={row.key}
						onChange={(event) => handleKeyChange(idx, event.currentTarget.value)}
						onBlur={handleBlur}
						placeholder={keyPlaceholder}
						disabled={isLocked}
						readOnly={inputProps.readOnly ?? false}
					/>
				) : (
					<Text size="sm">{row.key}</Text>
				)}
			</td>
			<td style={valueWidth ? { width: valueWidth } : undefined}>
				{renderValueControl(recordValue[row.key], row)}
			</td>
			<td style={{ width: 120 }}>{renderActions(idx)}</td>
		</tr>
	))

	const inlineAddRow = inlineAddEnabled ? (
		<tr>
			<td style={keyWidth ? { width: keyWidth } : undefined}>
				<Stack gap={4}>
					<TextInput
						value={draftKey}
						onChange={(event) => setDraftKey(event.currentTarget.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault()
								handleInlineAdd()
							}
						}}
						onBlur={handleBlur}
						placeholder={keyPlaceholder ?? keyLabel ?? 'Key'}
						disabled={isLocked}
						readOnly={inputProps.readOnly ?? false}
						ref={draftKeyRef}
					/>
					{draftKeyError ? (
						<Text size="xs" c="red.6">
							{draftKeyError}
						</Text>
					) : null}
				</Stack>
			</td>
			<td style={valueWidth ? { width: valueWidth } : undefined}>
				{(() => {
					if (valueKind === 'number') {
						return (
							<NumberInput
								value={
									typeof draftValue === 'number'
										? draftValue
										: draftValue == null
											? ''
											: Number(draftValue)
								}
								onChange={(val) => {
									const parsed = val === '' || val === undefined ? undefined : Number(val)
									const safe = Number.isNaN(parsed) ? undefined : parsed
									setDraftValue(safe)
								}}
								onKeyDown={(event) => {
									if (event.key === 'Enter') {
										event.preventDefault()
										handleInlineAdd()
									}
								}}
								onBlur={handleBlur}
								placeholder={valuePlaceholder ?? valueNumberMeta?.placeholder}
								min={valueNumberMeta?.min}
								max={valueNumberMeta?.max}
								step={valueNumberMeta?.step ?? (valueNumberMeta?.integer ? 1 : undefined)}
								disabled={isLocked}
							/>
						)
					}
					if (valueKind === 'boolean') {
						return (
							<Switch
								checked={Boolean(draftValue)}
								onChange={(event) => setDraftValue(event.currentTarget.checked)}
								onBlur={handleBlur}
								disabled={isLocked}
							/>
						)
					}
					if (valueKind === 'picklist') {
						return (
							<div>
								<PicklistControl
									meta={{
										options: valuePicklistMeta?.options,
										entries: valuePicklistMeta?.entries,
										labels: valuePicklistMeta?.labels,
										disabled: valuePicklistMeta?.disabled,
										placeholder: valuePicklistMeta?.placeholder ?? valuePlaceholder,
										searchable: valuePicklistMeta?.searchable,
										clearable: true,
										max: valuePicklistMeta?.max,
										create: valuePicklistMeta?.create,
										control: valuePicklistMeta?.control ?? 'select',
										multiple: false,
										emptyLabel: valuePicklistMeta?.emptyLabel,
									}}
									value={draftValue}
									onChange={(next) => setDraftValue(next)}
									onBlur={handleBlur}
									disabled={isLocked}
								/>
							</div>
						)
					}
					return (
						<TextInput
							value={toInputString(draftValue)}
							onChange={(event) => setDraftValue(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.preventDefault()
									handleInlineAdd()
								}
							}}
							onBlur={handleBlur}
							placeholder={valuePlaceholder ?? valueStringMeta?.placeholder ?? 'Value'}
							minLength={valueStringMeta?.minLength}
							maxLength={valueStringMeta?.maxLength}
							disabled={isLocked}
							readOnly={inputProps.readOnly ?? false}
						/>
					)
				})()}
			</td>
			<td style={{ width: 120 }}>
				<Group gap="xs" justify="flex-end">
					<ActionIcon
						variant="light"
						color="blue"
						onClick={handleInlineAdd}
						disabled={!draftKeyValid || isLocked}
						aria-label="添加"
						type="button"
					>
						<IconPlus size={16} />
					</ActionIcon>
				</Group>
			</td>
		</tr>
	) : null

	const listRows = rows.map((row, idx) => (
		<Card key={row.id} withBorder shadow="xs" p="md">
			<Group justify="space-between" align="center" mb="sm">
				<Group gap="xs">
					<Text fw={600}>{row.key || `#${idx + 1}`}</Text>
					{editableKey ? (
						<TextInput
							value={row.key}
							onChange={(event) => handleKeyChange(idx, event.currentTarget.value)}
							onBlur={handleBlur}
							placeholder={keyPlaceholder}
							disabled={isLocked}
							readOnly={inputProps.readOnly ?? false}
						/>
					) : null}
				</Group>
				{renderActions(idx)}
			</Group>
			<Stack gap={6}>{renderValueControl(recordValue[row.key], row)}</Stack>
		</Card>
	))

	const content =
		layout === 'table' && (rows.length > 0 || inlineAddEnabled) ? (
			<Table withTableBorder verticalSpacing="xs" horizontalSpacing="sm" highlightOnHover>
				<thead>
					<tr>
						<th style={keyWidth ? { width: keyWidth } : undefined}>{keyLabel}</th>
						<th style={valueWidth ? { width: valueWidth } : undefined}>{valueLabel}</th>
						<th>操作</th>
					</tr>
				</thead>
				<tbody>
					{tableRows}
					{inlineAddRow}
					{rows.length === 0 ? (
						<tr>
							<td colSpan={3}>
								<Text size="sm" c="dimmed" py={6}>
									{info.emptyHint ?? '暂无配置项'}
								</Text>
							</td>
						</tr>
					) : null}
				</tbody>
			</Table>
		) : rows.length === 0 ? (
			<Card withBorder shadow="xs" p="md">
				<Text size="sm" c="dimmed">
					{info.emptyHint ?? '暂无配置项'}
				</Text>
			</Card>
		) : (
			<Stack gap="md">{listRows}</Stack>
		)

	return (
		<FieldChrome
			errorId={inputProps.errorId}
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
			<Stack gap="md">
				{content}
				{canAdd && !inlineAddEnabled ? (
					<Button
						leftSection={<IconPlus size={16} />}
						variant="light"
						onClick={handleAdd}
						disabled={isLocked}
						type="button"
					>
						{addLabel}
					</Button>
				) : null}
			</Stack>
		</FieldChrome>
	)
}
