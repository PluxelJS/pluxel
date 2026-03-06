import {
	ActionIcon,
	Button,
	Card,
	Group,
	NumberInput,
	Table,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from '@mantine/core'
import {
	IconArrowDown,
	IconArrowUp,
	IconGripVertical,
	IconPlus,
	IconTrash,
} from '@tabler/icons-react'
import {
	DndContext,
	PointerSensor,
	type UniqueIdentifier,
	useSensor,
	useSensors,
	DragOverlay,
	closestCenter,
} from '@dnd-kit/core'
import { SortableContext, arrayMove, rectSortingStrategy, useSortable } from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_TEXTS, GRID_COLUMN_THRESHOLD } from '../../../core/constants'
import type {
	ArrayFieldNode,
	FieldNode,
	NumberFieldNode,
	PicklistFieldNode,
	StringFieldNode,
} from '../../../core/fields'
import { FieldChrome } from '../shared'
import { cleanProps } from '../../utils/propHelpers'
import { PicklistControl } from './controls/PicklistControl'
import { FieldRenderer } from '../internal/FieldRenderer'
import {
	isErrorWithPath,
	joinErrorMessages,
	normalizeErrorMessages,
	type FieldError,
	type RendererProps,
	type TriggerOptions,
	triggerFormBlur,
	triggerFormEvents,
} from './types'
import { buildNestedInputProps, tweakNestedNode } from './nested'

function cloneValue<T>(value: T): T {
	if (value == null || typeof value !== 'object') return value
	try {
		return structuredClone(value)
	} catch {
		return JSON.parse(JSON.stringify(value)) as T
	}
}

function defaultItemForNode(node?: FieldNode | null): unknown {
	if (!node) return ''
	switch (node.kind) {
		case 'string':
			return ''
		case 'number':
			return 0
		case 'boolean':
			return false
		case 'picklist': {
			const meta = node as PicklistFieldNode
			if (meta.entries?.length) return meta.entries[0].value
			if (meta.options?.length) return meta.options[0]
			return ''
		}
		case 'array':
			return []
		case 'record':
		case 'object':
		case 'union':
			return {}
		default:
			return ''
	}
}

interface ArrayItemLayoutInfo {
	compact: boolean
	maxColumns: 1 | 2 | 3
}

function analyzeArrayItemLayout(node?: FieldNode | null): ArrayItemLayoutInfo {
	if (!node) return { compact: false, maxColumns: 1 }
	switch (node.kind) {
		case 'boolean':
			return { compact: true, maxColumns: 3 }
		case 'number':
		case 'picklist':
			return { compact: true, maxColumns: 3 }
		case 'string': {
			const control = (node as any).control
			if (control === 'textarea' || control === 'code') return { compact: false, maxColumns: 1 }
			return { compact: true, maxColumns: 2 }
		}
		default:
			return { compact: false, maxColumns: 1 }
	}
}

function resolveArrayColumns(
	layoutInfo: ArrayItemLayoutInfo,
	itemCount: number,
	explicitColumns?: number,
	disableAutoGrid?: boolean,
): number {
	if (explicitColumns && explicitColumns > 0) {
		return Math.min(explicitColumns, layoutInfo.maxColumns)
	}
	if (disableAutoGrid) return 1
	if (!layoutInfo.compact) return 1
	if (itemCount < GRID_COLUMN_THRESHOLD) return 1
	if (itemCount >= 6 && layoutInfo.maxColumns >= 3) return 3
	if (itemCount >= 4 && layoutInfo.maxColumns >= 2) return 2
	if (itemCount >= 3 && layoutInfo.maxColumns >= 2) return 2
	return 1
}

export function reorderList<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
	if (
		fromIndex === toIndex ||
		fromIndex < 0 ||
		toIndex < 0 ||
		fromIndex >= list.length ||
		toIndex >= list.length
	) {
		return [...list]
	}
	// `arrayMove` expects a mutable array; keep `list` readonly-friendly.
	return arrayMove([...list], fromIndex, toIndex)
}

type SortableCardProps = {
	id: UniqueIdentifier
	children: ReactNode
	disabled?: boolean
}

function SortableCard(props: SortableCardProps) {
	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: props.id,
		disabled: props.disabled,
	})
	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.75 : undefined,
	}

	return (
		<div ref={setNodeRef} style={style} {...attributes} {...listeners}>
			{props.children}
		</div>
	)
}

type ArrayFieldPicklistProps = {
	node: RendererProps['node']
	items: unknown[]
	itemNode: PicklistFieldNode
	baseErrors: FieldError[]
	updateItems: (next: unknown[], options?: TriggerOptions) => void
	handleBlur: () => void
	isLocked: boolean
}

function ArrayFieldPicklist(props: ArrayFieldPicklistProps) {
	const { node, items, itemNode, baseErrors, updateItems, handleBlur, isLocked } = props

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
			<PicklistControl
				meta={{
					options: itemNode.options,
					entries: itemNode.entries,
					labels: itemNode.labels,
					disabled: itemNode.disabled,
					placeholder: itemNode.placeholder,
					searchable: itemNode.searchable,
					clearable: itemNode.clearable ?? true,
					max: itemNode.max,
					create: itemNode.create ?? false,
					control: itemNode.control ?? 'select',
					multiple: true,
					emptyLabel: itemNode.emptyLabel,
				}}
				value={items}
				onChange={(next) => {
					if (Array.isArray(next)) updateItems(next)
					else if (next == null) updateItems([])
					else updateItems([next])
				}}
				onBlur={handleBlur}
				disabled={isLocked}
				required={false}
			/>
		</FieldChrome>
	)
}

export function ArrayField(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const info = node as ArrayFieldNode
	const items = Array.isArray(value) ? (value as unknown[]) : []
	const itemNode = info.item ?? null

	const layoutInfo = analyzeArrayItemLayout(itemNode)
	const columns = resolveArrayColumns(layoutInfo, items.length, info.columns, info.disableAutoGrid)
	const preferredLayout = info.layout ?? (columns > 1 ? 'grid' : 'list')
	const layout =
		preferredLayout === 'picker' && itemNode?.kind !== 'picklist'
			? columns > 1
				? 'grid'
				: 'list'
			: preferredLayout
	const isLocked = Boolean(inputProps.disabled || inputProps.readOnly)

	if (layout === 'picker' && itemNode?.kind === 'picklist') {
		const baseErrors = normalizeErrorMessages(
			errors?.filter((err) => !isErrorWithPath(err) || (err.dotPath?.length ?? 0) <= 1),
		)

		const updateItems = (next: unknown[], options?: TriggerOptions) =>
			triggerFormEvents(inputProps, next, options)
		const handleBlur = () => triggerFormBlur(inputProps)

		return (
			<ArrayFieldPicklist
				node={node}
				items={items}
				itemNode={itemNode as PicklistFieldNode}
				baseErrors={baseErrors}
				updateItems={updateItems}
				handleBlur={handleBlur}
				isLocked={isLocked}
			/>
		)
	}

	return <ArrayFieldMain {...props} />
}

function ArrayFieldMain(props: RendererProps) {
	const { node, errors, inputProps, value } = props
	const info = node as ArrayFieldNode
	const items = Array.isArray(value) ? (value as unknown[]) : []
	const itemNode = info.item ?? null

	const layoutInfo = analyzeArrayItemLayout(itemNode)
	const columns = resolveArrayColumns(layoutInfo, items.length, info.columns, info.disableAutoGrid)
	const preferredLayout = info.layout ?? (columns > 1 ? 'grid' : 'list')
	const layout =
		preferredLayout === 'picker' && itemNode?.kind !== 'picklist'
			? columns > 1
				? 'grid'
				: 'list'
			: preferredLayout
	const isLocked = Boolean(inputProps.disabled || inputProps.readOnly)

	const minItems = info.min ?? 0
	const maxItems = info.max
	const canAdd = info.addable !== false && !isLocked && (!maxItems || items.length < maxItems)
	const canRemove = info.removable !== false
	const canReorder = info.reorderable !== false && items.length > 1
	const itemLabel = info.itemLabel ?? node.meta.label ?? DEFAULT_TEXTS.array.itemLabel
	const addLabel = info.addLabel ?? (itemLabel ? `添加${itemLabel}` : DEFAULT_TEXTS.array.addItem)

	const baseErrors = normalizeErrorMessages(
		errors?.filter((err) => !isErrorWithPath(err) || (err.dotPath?.length ?? 0) <= 1),
	)

	const itemErrorsMap = useMemo(() => {
		const map = new Map<number, FieldError[]>()
		for (const err of errors ?? []) {
			if (!isErrorWithPath(err)) continue
			if ((err.dotPath?.length ?? 0) <= 1) continue
			const idx = Number(err.dotPath?.[1])
			if (Number.isNaN(idx)) continue
			if (!map.has(idx)) map.set(idx, [])
			map.get(idx)!.push({ ...err, dotPath: err.dotPath?.slice(1) })
		}
		return map
	}, [errors])

	const [jsonParseErrors, setJsonParseErrors] = useState<Record<number, string | undefined>>({})

	useEffect(() => {
		setJsonParseErrors({})
	}, [items.length])

	const updateItems = (next: unknown[], options?: TriggerOptions) =>
		triggerFormEvents(inputProps, next, options)
	const handleBlur = () => triggerFormBlur(inputProps)

	const handleAdd = () => {
		const template = info.defaultItem ?? defaultItemForNode(itemNode)
		updateItems([...items, cloneValue(template)], { blur: true })
	}

	const handleRemove = (index: number) => {
		if (!canRemove || isLocked) return
		if (items.length <= minItems) return
		const next = items.filter((_, idx) => idx !== index)
		updateItems(next, { blur: true })
	}

	const handleMove = (index: number, direction: number) => {
		if (!canReorder || isLocked) return
		const target = index + direction
		updateItems(reorderList(items, index, target), { blur: true })
	}

	const handleChange = (index: number, nextValue: unknown, options?: TriggerOptions) => {
		const next = [...items]
		next[index] = nextValue
		updateItems(next, options)
	}

	type ControlRenderResult = { node: ReactNode; inline?: boolean }
	type ControlRenderOptions = { compact?: boolean }

	const inferredPrimitiveKind = useMemo(() => {
		for (const item of items) {
			if (typeof item === 'string') return 'string'
			if (typeof item === 'number') return 'number'
			if (typeof item === 'boolean') return 'boolean'
			if (item == null) continue
			break
		}
		return null
	}, [items])

	const compactKind = itemNode?.kind ?? inferredPrimitiveKind
	const numberMeta = itemNode?.kind === 'number' ? (itemNode as NumberFieldNode) : null
	const stringMeta = itemNode?.kind === 'string' ? (itemNode as StringFieldNode) : null
	const picklistMeta = itemNode?.kind === 'picklist' ? (itemNode as PicklistFieldNode) : null
	const isLongText = stringMeta?.control === 'textarea' || stringMeta?.control === 'code'
	const isCompactList =
		layout === 'list' &&
		(compactKind === 'string' ||
			compactKind === 'number' ||
			compactKind === 'boolean' ||
			compactKind === 'picklist') &&
		!(compactKind === 'string' && isLongText)
	const inlineAddEnabled = isCompactList && canAdd && !isLocked
	const [draftValue, setDraftValue] = useState<unknown>(undefined)
	const draftFocusRef = useRef<HTMLInputElement | null>(null)
	const draftPicklistRef = useRef<HTMLDivElement | null>(null)

	useEffect(() => {
		setDraftValue(undefined)
	}, [compactKind])

	useEffect(() => {
		if (!inlineAddEnabled) return
		setDraftValue((prev: unknown) => {
			if (prev !== undefined) return prev
			const template = info.defaultItem ?? defaultItemForNode(itemNode)
			return cloneValue(template)
		})
	}, [inlineAddEnabled, compactKind, info.defaultItem, itemNode])

	useEffect(() => {
		if (!inlineAddEnabled) return
		requestAnimationFrame(() => {
			if (draftFocusRef.current) {
				draftFocusRef.current.focus()
				return
			}
			const picklistInput = draftPicklistRef.current?.querySelector('input')
			picklistInput?.focus()
		})
	}, [inlineAddEnabled, items.length])

	const renderJsonFallback = (index: number, current: unknown, fallback: 'array' | 'object') => {
		const formatted =
			current && typeof current === 'object'
				? JSON.stringify(current, null, 2)
				: fallback === 'array'
					? '[]'
					: '{}'
		return (
			<Textarea
				key={`${index}-${items.length}`}
				defaultValue={formatted}
				minRows={4}
				autosize
				onBlur={(event) => {
					if (isLocked) return
					const value = (event.currentTarget as HTMLTextAreaElement).value
					try {
						const parsed = JSON.parse(value || formatted)
						handleChange(index, parsed, { blur: true })
						setJsonParseErrors((prev) => {
							const next = { ...prev }
							delete next[index]
							return next
						})
					} catch {
						setJsonParseErrors((prev) => ({
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

	const renderControl = (
		index: number,
		current: unknown,
		options: ControlRenderOptions = {},
	): ControlRenderResult => {
		const inferredType =
			itemNode?.kind ??
			(typeof current === 'number'
				? 'number'
				: typeof current === 'boolean'
					? 'boolean'
					: typeof current === 'string'
						? 'string'
						: current && typeof current === 'object'
							? 'json'
							: 'string')

		switch (inferredType) {
			case 'number':
				return {
					node: (
						<NumberInput
							value={typeof current === 'number' ? current : ''}
							onChange={(val) => {
								const parsed = val === '' || val === undefined ? undefined : Number(val)
								const safe = Number.isNaN(parsed) ? undefined : parsed
								handleChange(index, safe)
							}}
							onBlur={handleBlur}
							placeholder={numberMeta?.placeholder}
							min={numberMeta?.min}
							max={numberMeta?.max}
							step={numberMeta?.step ?? (numberMeta?.integer ? 1 : undefined)}
							disabled={isLocked}
						/>
					),
				}
			case 'boolean':
				return {
					inline: options.compact ? false : true,
					node: (
						<Switch
							label={options.compact ? undefined : `${itemLabel} #${index + 1}`}
							checked={Boolean(current)}
							onChange={(event) => {
								handleChange(index, (event.currentTarget as HTMLInputElement).checked)
							}}
							onBlur={handleBlur}
							disabled={isLocked}
						/>
					),
				}
			case 'picklist': {
				return {
					node: (
						<PicklistControl
							meta={{
								options: picklistMeta?.options,
								entries: picklistMeta?.entries,
								labels: picklistMeta?.labels,
								disabled: picklistMeta?.disabled,
								placeholder: picklistMeta?.placeholder,
								searchable: picklistMeta?.searchable,
								clearable: picklistMeta?.clearable ?? true,
								max: picklistMeta?.max,
								create: picklistMeta?.create,
								control: picklistMeta?.control ?? 'select',
								multiple: false,
								emptyLabel: picklistMeta?.emptyLabel,
							}}
							value={current}
							onChange={(next) => handleChange(index, next)}
							onBlur={handleBlur}
							disabled={isLocked}
						/>
					),
				}
			}
			case 'string': {
				const control = stringMeta?.control ?? 'text'
				if (control === 'textarea' || control === 'code') {
					return {
						node: (
							<Textarea
								value={
									typeof current === 'string' ? current : current == null ? '' : String(current)
								}
								onChange={(event) =>
									handleChange(index, (event.currentTarget as HTMLTextAreaElement).value)
								}
								onBlur={handleBlur}
								minRows={stringMeta?.rows ?? 3}
								autosize
								disabled={inputProps.disabled ?? false}
								readOnly={inputProps.readOnly ?? false}
								placeholder={stringMeta?.placeholder}
								minLength={stringMeta?.minLength}
								maxLength={stringMeta?.maxLength}
								styles={
									control === 'code'
										? { input: { fontFamily: 'var(--mantine-font-family-monospace)' } }
										: undefined
								}
							/>
						),
					}
				}
				return {
					node: (
						<TextInput
							value={typeof current === 'string' ? current : current == null ? '' : String(current)}
							onChange={(event) => {
								handleChange(index, (event.currentTarget as HTMLInputElement).value)
							}}
							onBlur={handleBlur}
							type={control === 'password' ? 'password' : 'text'}
							disabled={inputProps.disabled ?? false}
							readOnly={inputProps.readOnly ?? false}
							placeholder={stringMeta?.placeholder}
							minLength={stringMeta?.minLength}
							maxLength={stringMeta?.maxLength}
						/>
					),
				}
			}
			case 'object':
			case 'array':
			case 'union':
			case 'record': {
				if (!itemNode) {
					return {
						node: renderJsonFallback(index, current, inferredType === 'array' ? 'array' : 'object'),
					}
				}
				const nestedNode = tweakNestedNode(itemNode)
				const nestedName = inputProps.name ? `${inputProps.name}.${index}` : String(index)
				const nestedInputProps = buildNestedInputProps(inputProps, nestedName, (nextValue) =>
					handleChange(index, nextValue),
				)
				const itemErrors = itemErrorsMap.get(index) ?? []
				return {
					node: (
						<FieldRenderer
							node={nestedNode}
							value={current}
							errors={itemErrors}
							inputProps={nestedInputProps}
						/>
					),
				}
			}
			case 'json':
				return { node: renderJsonFallback(index, current, 'object') }
			default:
				return {
					node: (
						<TextInput
							value={typeof current === 'string' ? current : current == null ? '' : String(current)}
							onChange={(event) => {
								handleChange(index, (event.currentTarget as HTMLInputElement).value)
							}}
							onBlur={handleBlur}
							disabled={inputProps.disabled ?? false}
							readOnly={inputProps.readOnly ?? false}
						/>
					),
				}
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
						disabled={idx === items.length - 1 || isLocked}
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
					disabled={isLocked || items.length <= minItems}
					aria-label="删除"
					type="button"
				>
					<IconTrash size={16} />
				</ActionIcon>
			) : null}
		</Group>
	)

	const renderErrors = (idx: number) => {
		const combined = [
			...(itemErrorsMap.get(idx) ?? []),
			...(jsonParseErrors[idx] ? [jsonParseErrors[idx]] : []),
		]
		const errorText = joinErrorMessages(combined)
		if (!errorText) return null
		return (
			<Text size="xs" c="red.6" style={{ whiteSpace: 'pre-line' }}>
				{errorText}
			</Text>
		)
	}

	const handleInlineAdd = () => {
		const template = info.defaultItem ?? defaultItemForNode(itemNode)
		const valueToAdd =
			draftValue === undefined ||
			draftValue === null ||
			(typeof draftValue === 'number' && Number.isNaN(draftValue))
				? template
				: draftValue
		updateItems([...items, cloneValue(valueToAdd)], { blur: true })
		setDraftValue(undefined)
	}

	const inlineAddRow = inlineAddEnabled ? (
		<tr>
			<td style={{ width: 56 }}>
				<Text size="sm" c="dimmed">
					+
				</Text>
			</td>
			<td>
				{compactKind === 'number' ? (
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
						ref={draftFocusRef}
						onKeyDown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault()
								handleInlineAdd()
							}
						}}
						onBlur={handleBlur}
						placeholder={numberMeta?.placeholder}
						min={numberMeta?.min}
						max={numberMeta?.max}
						step={numberMeta?.step ?? (numberMeta?.integer ? 1 : undefined)}
						disabled={isLocked}
					/>
				) : compactKind === 'boolean' ? (
					<Switch
						checked={Boolean(draftValue)}
						onChange={(event) => setDraftValue(event.currentTarget.checked)}
						onBlur={handleBlur}
						disabled={isLocked}
					/>
				) : compactKind === 'picklist' ? (
					<div ref={draftPicklistRef}>
						<PicklistControl
							meta={{
								options: picklistMeta?.options,
								entries: picklistMeta?.entries,
								labels: picklistMeta?.labels,
								disabled: picklistMeta?.disabled,
								placeholder: picklistMeta?.placeholder,
								searchable: picklistMeta?.searchable,
								clearable: true,
								max: picklistMeta?.max,
								create: picklistMeta?.create,
								control: picklistMeta?.control ?? 'select',
								multiple: false,
								emptyLabel: picklistMeta?.emptyLabel,
							}}
							value={draftValue}
							onChange={(next) => setDraftValue(next)}
							onBlur={handleBlur}
							disabled={isLocked}
						/>
					</div>
				) : (
					<TextInput
						value={
							typeof draftValue === 'string'
								? draftValue
								: draftValue == null
									? ''
									: String(draftValue)
						}
						onChange={(event) => setDraftValue(event.currentTarget.value)}
						ref={draftFocusRef}
						onKeyDown={(event) => {
							if (event.key === 'Enter') {
								event.preventDefault()
								handleInlineAdd()
							}
						}}
						onBlur={handleBlur}
						placeholder={stringMeta?.placeholder}
						minLength={stringMeta?.minLength}
						maxLength={stringMeta?.maxLength}
						disabled={isLocked}
						readOnly={inputProps.readOnly ?? false}
					/>
				)}
			</td>
			<td style={{ width: 120 }}>
				<Group gap="xs" justify="flex-end">
					<ActionIcon
						variant="light"
						color="blue"
						onClick={handleInlineAdd}
						disabled={isLocked}
						aria-label="添加"
						type="button"
					>
						<IconPlus size={16} />
					</ActionIcon>
				</Group>
			</td>
		</tr>
	) : null

	const renderItemCard = (item: unknown, idx: number) => {
		const control = renderControl(idx, item)
		const inline = layout === 'grid' ? false : control.inline
		const errorsNode = renderErrors(idx)
		const actionsNode = (
			<Group gap="xs" align="center">
				{canReorder && !isCompactList ? (
					<IconGripVertical size={16} style={{ cursor: 'grab', opacity: 0.75 }} />
				) : null}
				{renderActions(idx)}
			</Group>
		)

		if (inline) {
			return {
				inline: true,
				element: (
					<Card
						key={`${idx}-${layout}`}
						withBorder
						shadow="xs"
						p="md"
						style={{ flex: '0 1 280px' }}
					>
						<Group justify="space-between" align="center">
							{control.node}
							{actionsNode}
						</Group>
						{errorsNode ? <div style={{ marginTop: 6 }}>{errorsNode}</div> : null}
					</Card>
				),
			}
		}

		return {
			inline: false,
			element: (
				<Card key={`${idx}-${layout}`} withBorder shadow="xs" p="md">
					<Group justify="space-between" mb="sm">
						<Text fw={600}>
							{itemLabel} #{idx + 1}
						</Text>
						{actionsNode}
					</Group>
					<Stack gap={6}>
						{control.node}
						{errorsNode}
					</Stack>
				</Card>
			),
		}
	}

	const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }))
	const reorderEnabled = canReorder && !isLocked
	const dragEnabled = reorderEnabled && !isCompactList
	const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)

	const renderedCards = items.map((item, idx) => ({
		...renderItemCard(item, idx),
		id: `item-${idx}` as const,
	}))
	const inlineCards = renderedCards.filter((item) => item.inline)
	const blockCards = renderedCards.filter((item) => !item.inline)

	const tableRows = items.map((item, idx) => {
		const control = renderControl(idx, item, { compact: true })
		const errorsNode = renderErrors(idx)
		return (
			<tr key={`row-${idx}`}>
				<td style={{ width: 56 }}>
					<Text size="sm" c="dimmed">
						#{idx + 1}
					</Text>
				</td>
				<td>
					<Stack gap={4}>
						{control.node}
						{errorsNode}
					</Stack>
				</td>
				<td style={{ width: 120 }}>{renderActions(idx)}</td>
			</tr>
		)
	})

	const dragOverlay =
		activeId !== null ? (
			<DragOverlay>
				<Card shadow="lg" padding="md" radius="sm">
					<Text size="sm" c="dimmed">
						拖拽以调整顺序...
					</Text>
				</Card>
			</DragOverlay>
		) : null

	const wrapSortable = (content: ReactNode) =>
		dragEnabled ? (
			<DndContext
				sensors={sensors}
				collisionDetection={closestCenter}
				onDragStart={(event) => setActiveId(event.active.id)}
				onDragEnd={(event) => {
					setActiveId(null)
					const { active, over } = event
					if (!over || active.id === over.id) return
					const from = renderedCards.findIndex((item) => item.id === active.id)
					const to = renderedCards.findIndex((item) => item.id === over.id)
					updateItems(reorderList(items, from, to), { blur: true })
				}}
				onDragCancel={() => setActiveId(null)}
			>
				<SortableContext
					items={renderedCards.map((item) => item.id)}
					strategy={rectSortingStrategy}
				>
					{content}
				</SortableContext>
				{dragOverlay}
			</DndContext>
		) : (
			content
		)

	const sortableBlockCards =
		reorderEnabled && blockCards.length
			? blockCards.map((item) => (
					<SortableCard key={item.id} id={item.id} disabled={!reorderEnabled}>
						{item.element}
					</SortableCard>
				))
			: blockCards.map((item) => item.element)

	const sortableInlineCards =
		reorderEnabled && inlineCards.length
			? inlineCards.map((item) => (
					<SortableCard key={item.id} id={item.id} disabled={!reorderEnabled}>
						{item.element}
					</SortableCard>
				))
			: inlineCards.map((item) => item.element)

	const itemsNode =
		isCompactList && (items.length > 0 || inlineAddEnabled) ? (
			<Table withTableBorder verticalSpacing="xs" horizontalSpacing="sm" highlightOnHover>
				<thead>
					<tr>
						<th style={{ width: 56 }}>#</th>
						<th>{itemLabel}</th>
						<th />
					</tr>
				</thead>
				<tbody>
					{tableRows}
					{inlineAddRow}
					{items.length === 0 ? (
						<tr>
							<td colSpan={3}>
								<Text size="sm" c="dimmed" py={6}>
									{info.emptyHint ?? DEFAULT_TEXTS.array.emptyHint}
								</Text>
							</td>
						</tr>
					) : null}
				</tbody>
			</Table>
		) : items.length === 0 ? (
			<Card withBorder shadow="xs" p="md">
				<Text size="sm" c="dimmed">
					{info.emptyHint ?? DEFAULT_TEXTS.array.emptyHint}
				</Text>
			</Card>
		) : layout === 'grid' ? (
			wrapSortable(
				<SimpleGrid cols={columns} spacing="md">
					{sortableBlockCards}
				</SimpleGrid>,
			)
		) : (
			wrapSortable(
				<>
					{sortableInlineCards.length ? (
						<Group gap="md" wrap="wrap">
							{sortableInlineCards}
						</Group>
					) : null}
					{sortableBlockCards.length ? <Stack gap="md">{sortableBlockCards}</Stack> : null}
				</>,
			)
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
				{itemsNode}
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
