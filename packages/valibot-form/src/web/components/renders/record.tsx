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
	isErrorWithPath,
	joinErrorMessages,
	normalizeErrorMessages,
	type RendererProps,
	type TriggerOptions,
	triggerFormBlur,
	triggerFormEvents,
} from './types'
import { buildNestedInputProps, tweakNestedNode } from './nested'

type ValueKind = FieldNode['kind'] | 'json' | null

type RecordRow = {
	id: string
	key: string
	value: unknown
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
	const { node, errors, inputProps, value } = props
	const info = node as RecordFieldNode
	const renderField = useFieldRenderer()
	const layout = info.layout ?? 'table'

	const rowIdRef = useRef(0)
	const buildRow = (key: string, rowValue: unknown): RecordRow => ({
		id: `row_${rowIdRef.current++}`,
		key,
		value: rowValue,
	})

	const entries = useMemo(() => Object.entries((value as Record<string, unknown>) ?? {}), [value])

	const [rows, setRows] = useState<RecordRow[]>(() =>
		Object.entries((value as Record<string, unknown>) ?? {}).map(([key, rowValue]) =>
			buildRow(key, rowValue),
		),
	)

	useEffect(() => {
		setRows((prev) => {
			if (entries.length === 0 && prev.length === 0) return prev
			const entryMap = new Map(entries)
			const seen = new Set<string>()
			const next: RecordRow[] = []

			for (const row of prev) {
				if (!entryMap.has(row.key)) continue
				const nextValue = entryMap.get(row.key)
				const nextRow = row.value === nextValue ? row : { ...row, value: nextValue }
				next.push(nextRow)
				seen.add(row.key)
			}

			for (const [key, rowValue] of entries) {
				if (seen.has(key)) continue
				next.push(buildRow(key, rowValue))
			}

			if (
				next.length === prev.length &&
				next.every(
					(row, idx) =>
						row.id === prev[idx].id && row.key === prev[idx].key && row.value === prev[idx].value,
				)
			) {
				return prev
			}
			return next
		})
	}, [entries])

	const inferredValueKind = useMemo<ValueKind>(() => {
		for (const row of rows) {
			const kind = inferValueKind(row.value)
			if (kind) return kind
		}
		return null
	}, [rows])

	const minItems = info.min ?? 0
	const maxItems = info.max
	const isLocked = Boolean(inputProps.disabled || inputProps.readOnly)
	const canAdd = info.addable !== false && !isLocked && (!maxItems || rows.length < maxItems)
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
	}, [valueKind])

	useEffect(() => {
		if (!inlineAddEnabled) return undefined
		const handle = requestAnimationFrame(() => {
			draftKeyRef.current?.focus()
		})
		return () => cancelAnimationFrame(handle)
	}, [inlineAddEnabled, rows.length])

	const baseErrors = normalizeErrorMessages(
		errors?.filter((err) => !isErrorWithPath(err) || (err.dotPath?.length ?? 0) <= 1),
	)

	const entryErrors = useMemo(() => {
		const map = new Map<string, { message: string; dotPath?: string[] }[]>()
		for (const err of errors ?? []) {
			if (!isErrorWithPath(err)) continue
			if ((err.dotPath?.length ?? 0) <= 1) continue
			const key = String(err.dotPath?.[1])
			if (!map.has(key)) map.set(key, [])
			map.get(key)!.push({ message: err.message, dotPath: err.dotPath?.slice(1) })
		}
		return map
	}, [errors])

	const [jsonErrors, setJsonErrors] = useState<Record<number, string | undefined>>({})

	useEffect(() => {
		setJsonErrors({})
	}, [rows.length])

	const commitRows = (nextRows: RecordRow[], options?: TriggerOptions) => {
		const next: Record<string, unknown> = {}
		for (const row of nextRows) {
			next[row.key] = row.value
		}
		triggerFormEvents(inputProps, next, options)
	}
	const handleBlur = () => triggerFormBlur(inputProps)

	const existingKeySet = useMemo(() => new Set(rows.map((row) => row.key)), [rows])
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
		if (!draftKeyValid) return
		const valueToAdd = resolveDraftValue()
		commitRows(
			[...rows, { id: `row_${rowIdRef.current++}`, key: draftKeyTrimmed, value: valueToAdd }],
			{
				blur: true,
			},
		)
		setDraftKey('')
		setDraftValue(undefined)
	}

	const handleKeyChange = (index: number, nextKey: string) => {
		const current = rows[index]
		if (!current) return
		if (nextKey !== current.key && existingKeySet.has(nextKey)) return
		const next = rows.map((row, idx) => (idx === index ? { ...row, key: nextKey } : row))
		setRows(next)
		commitRows(next)
	}

	const handleValueChange = (index: number, nextValue: unknown) => {
		const current = rows[index]
		if (!current) return
		const next = rows.map((row, idx) => (idx === index ? { ...row, value: nextValue } : row))
		setRows(next)
		commitRows(next)
	}

	const handleRemove = (index: number) => {
		if (!canRemove || isLocked) return
		if (rows.length <= minItems) return
		const next = rows.filter((_, idx) => idx !== index)
		setRows(next)
		commitRows(next, { blur: true })
	}

	const handleMove = (index: number, direction: number) => {
		if (!canReorder || isLocked) return
		const target = index + direction
		if (target < 0 || target >= rows.length) return
		const next = [...rows]
		const [removed] = next.splice(index, 1)
		next.splice(target, 0, removed)
		setRows(next)
		commitRows(next, { blur: true })
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
		const next: RecordRow[] = [
			...rows,
			{ id: `row_${rowIdRef.current++}`, key: nextKey, value: nextValue },
		]
		setRows(next)
		commitRows(next, { blur: true })
	}

	const renderJsonFallback = (index: number, current: unknown, fallback: 'array' | 'object') => {
		const formatted =
			current && typeof current === 'object'
				? JSON.stringify(current, null, 2)
				: fallback === 'array'
					? '[]'
					: '{}'
		return (
			<Textarea
				key={`${index}-${rows.length}`}
				defaultValue={formatted}
				minRows={4}
				autosize
				onBlur={(event) => {
					if (isLocked) return
					const inputValue = (event.currentTarget as HTMLTextAreaElement).value
					try {
						const parsed = JSON.parse(inputValue || formatted)
						handleValueChange(index, parsed)
						handleBlur()
						setJsonErrors((prev) => {
							const next = { ...prev }
							delete next[index]
							return next
						})
					} catch {
						setJsonErrors((prev) => ({
							...prev,
							[index]: DEFAULT_TEXTS.validation.jsonError,
						}))
					}
				}}
				disabled={inputProps.disabled ?? false}
				readOnly={inputProps.readOnly ?? false}
				styles={{
					input: { fontFamily: 'var(--mantine-font-family-monospace)' },
				}}
			/>
		)
	}

	const renderValueControl = (index: number, current: unknown, recordKey: string) => {
		const inferredType = valueNode?.kind ?? inferValueKind(current) ?? 'string'

		switch (inferredType) {
			case 'number':
				return (
					<NumberInput
						{...cleanProps({
							value: typeof current === 'number' ? current : '',
							onChange: (val: string | number) => {
								const parsed = val === '' || val === undefined ? undefined : Number(val)
								const safe = Number.isNaN(parsed) ? undefined : parsed
								handleValueChange(index, safe)
							},
							onBlur: handleBlur,
							disabled: isLocked,
							placeholder: valuePlaceholder ?? valueNumberMeta?.placeholder,
							min: valueNumberMeta?.min,
							max: valueNumberMeta?.max,
							step: valueNumberMeta?.step ?? (valueNumberMeta?.integer ? 1 : undefined),
						})}
					/>
				)
			case 'boolean':
				return (
					<Switch
						{...cleanProps({
							checked: Boolean(current),
							onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
								handleValueChange(index, event.currentTarget.checked),
							onBlur: handleBlur,
							disabled: isLocked,
						})}
					/>
				)
			case 'picklist': {
				const meta = valueNode as PicklistFieldNode
				return (
					<PicklistControl
						meta={{
							options: meta.options,
							entries: meta.entries,
							labels: meta.labels,
							disabled: meta.disabled,
							placeholder: meta.placeholder,
							searchable: meta.searchable,
							clearable: meta.clearable ?? true,
							max: meta.max,
							create: meta.create,
							control: meta.control ?? 'select',
							multiple: false,
							emptyLabel: meta.emptyLabel,
						}}
						value={current}
						onChange={(next) => handleValueChange(index, next)}
						onBlur={handleBlur}
						disabled={isLocked}
					/>
				)
			}
			case 'string': {
				const control = valueStringMeta?.control ?? 'text'
				if (control === 'textarea' || control === 'code') {
					return (
						<Textarea
							value={typeof current === 'string' ? current : ''}
							onChange={(event) =>
								handleValueChange(index, (event.currentTarget as HTMLTextAreaElement).value)
							}
							onBlur={handleBlur}
							minRows={valueStringMeta?.rows ?? 3}
							autosize
							disabled={inputProps.disabled ?? false}
							readOnly={inputProps.readOnly ?? false}
							placeholder={valuePlaceholder ?? valueStringMeta?.placeholder}
							minLength={valueStringMeta?.minLength}
							maxLength={valueStringMeta?.maxLength}
							styles={
								control === 'code'
									? { input: { fontFamily: 'var(--mantine-font-family-monospace)' } }
									: undefined
							}
						/>
					)
				}
				return (
					<TextInput
						{...cleanProps({
							value: typeof current === 'string' ? current : '',
							onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
								handleValueChange(index, event.currentTarget.value),
							onBlur: handleBlur,
							disabled: inputProps.disabled,
							placeholder: valuePlaceholder ?? valueStringMeta?.placeholder,
							minLength: valueStringMeta?.minLength,
							maxLength: valueStringMeta?.maxLength,
						})}
						readOnly={inputProps.readOnly ?? false}
					/>
				)
			}
			case 'array':
			case 'object':
			case 'record':
			case 'union': {
				if (!valueNode) {
					return renderJsonFallback(index, current, inferredType === 'array' ? 'array' : 'object')
				}

				const nestedName = inputProps.name ? `${inputProps.name}.${recordKey}` : recordKey
				const nestedInputProps = buildNestedInputProps(inputProps, nestedName, (nextValue) =>
					handleValueChange(index, nextValue),
				)

				const itemErrors = entryErrors.get(recordKey) ?? []
				const nestedNode = tweakNestedNode(valueNode)

				return renderField({
					node: nestedNode,
					value: current,
					errors: itemErrors,
					inputProps: nestedInputProps,
				})
			}
			case 'json':
				return renderJsonFallback(index, current, Array.isArray(current) ? 'array' : 'object')
			default:
				return (
					<TextInput
						{...cleanProps({
							value: typeof current === 'string' ? current : current == null ? '' : String(current),
							onChange: (event: React.ChangeEvent<HTMLInputElement>) =>
								handleValueChange(index, event.currentTarget.value),
							onBlur: handleBlur,
							disabled: inputProps.disabled,
							placeholder: valuePlaceholder,
						})}
						readOnly={inputProps.readOnly ?? false}
					/>
				)
		}
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

	const renderErrors = (idx: number, recordKey: string) => {
		const combined = [
			...(entryErrors.get(recordKey) ?? []),
			...(jsonErrors[idx] ? [jsonErrors[idx]] : []),
		]
		const errorText = joinErrorMessages(combined)
		if (!errorText) return null
		return (
			<Text size="xs" c="red.6" style={{ whiteSpace: 'pre-line' }}>
				{errorText}
			</Text>
		)
	}

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
				{renderValueControl(idx, row.value, row.key)}
				{renderErrors(idx, row.key)}
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
							value={
								typeof draftValue === 'string'
									? draftValue
									: draftValue == null
										? ''
										: String(draftValue)
							}
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
			<Stack gap={6}>
				{renderValueControl(idx, row.value, row.key)}
				{renderErrors(idx, row.key)}
			</Stack>
		</Card>
	))

	const content =
		layout === 'table' && (rows.length > 0 || inlineAddEnabled) ? (
			<Table withTableBorder verticalSpacing="xs" horizontalSpacing="sm" highlightOnHover>
				<thead>
					<tr>
						<th style={keyWidth ? { width: keyWidth } : undefined}>{keyLabel}</th>
						<th style={valueWidth ? { width: valueWidth } : undefined}>{valueLabel}</th>
						<th />
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
