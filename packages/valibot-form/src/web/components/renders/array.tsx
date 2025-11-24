import {
	ActionIcon,
	Button,
	Card,
	Group,
	NumberInput,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Text,
	Textarea,
	TextInput,
} from '@mantine/core'
import { IconArrowDown, IconArrowUp, IconGripVertical, IconPlus, IconTrash } from '@tabler/icons-react'
import {
	DndContext,
	PointerSensor,
	type UniqueIdentifier,
	useSensor,
	useSensors,
	DragOverlay,
	closestCenter,
} from '@dnd-kit/core'
import {
	SortableContext,
	arrayMove,
	rectSortingStrategy,
	useSortable,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { DEFAULT_TEXTS } from '~/core/constants'
import type { ArrayMetaResult } from '~/core/actions/array'
import type { CommonProps } from '~/core/registry'
import { registerRenderer, triggerFormEvents } from '~/core/registry'
import { META_MAP } from '~/core/utils'
import { FieldChrome } from '../shared'
import { cleanProps } from '../../utils/propHelpers'
import { PicklistControl } from './controls/PicklistControl'

type RendererProps = CommonProps<typeof META_MAP.ARRAY> & { value?: unknown[] }
type ArrayUI = ArrayMetaResult

const idOf = (value: string | number) => String(value)

function buildPicklistData(config?: NonNullable<ArrayUI['picklist']>) {
	if (!config) return { data: [], map: new Map<string, string | number>(), isAllNumbers: false }
	const map = new Map<string, string | number>()
	const disabled = new Set((config.disabled ?? []).map((item) => idOf(item)))
	const data = (config.options ?? []).map((opt) => {
		const id = idOf(opt)
		map.set(id, opt)
		return {
			value: id,
			label: config.labels?.[opt] ?? String(opt),
			disabled: disabled.has(id),
		}
	})
	const isAllNumbers = (config.options ?? []).every((opt) => typeof opt === 'number')
	return { data, map, isAllNumbers }
}

function inferMode(
	mode: ArrayUI['valueMode'],
	value: unknown,
): Exclude<ArrayUI['valueMode'], 'auto' | undefined> | 'string' {
	if (mode && mode !== 'auto') return mode
	if (typeof value === 'number') return 'number'
	if (typeof value === 'boolean') return 'boolean'
	if (value && typeof value === 'object') return 'json'
	return 'string'
}

function cloneValue<T>(value: T): T {
	if (value == null || typeof value !== 'object') return value
	try {
		return structuredClone(value)
	} catch {
		return JSON.parse(JSON.stringify(value)) as T
	}
}

function defaultByMode(
	mode: Exclude<ArrayUI['valueMode'], undefined>,
	options?: readonly (string | number)[],
) {
	if (mode === 'picklist') return options?.[0] ?? ''
	switch (mode) {
		case 'number':
			return 0
		case 'boolean':
			return false
		case 'json':
			return {}
		case 'auto':
			return ''
		default:
			return ''
	}
}

export function reorderList<T>(list: readonly T[], fromIndex: number, toIndex: number): T[] {
	if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= list.length || toIndex >= list.length) {
		return [...list]
	}
	return arrayMove(list, fromIndex, toIndex)
}

type SortableCardProps = {
	id: UniqueIdentifier
	children: ReactNode
	dragHandle?: ReactNode
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

function ArrayField(props: RendererProps) {
	const { formBaseInfo, errors, extractedPropsInfo, inputProps, value } = props
	const ep = extractedPropsInfo ?? {}
	const items = Array.isArray(value) ? (value as unknown[]) : []
	const layout = ep.layout ?? ep.style ?? 'list'
	const columns = layout === 'grid' ? (ep.columns ?? 2) : 1
	const minItems = ep.minItems ?? 0
	const maxItems = ep.maxItems
	const canAdd =
		ep.addable !== false && !inputProps.disabled && (!maxItems || items.length < maxItems)
	const canRemove = ep.removable !== false
	const canReorder = ep.reorderable !== false
	const itemLabel = ep.itemLabel ?? formBaseInfo.label ?? DEFAULT_TEXTS.array.itemLabel

	const pickMeta = useMemo(() => buildPicklistData(ep.picklist), [ep.picklist])
	const [jsonParseErrors, setJsonParseErrors] = useState<Record<number, string | undefined>>({})

	useEffect(() => {
		setJsonParseErrors({})
	}, [items.length])

	const baseErrors = (errors ?? [])
		.filter((err) => err.dotPath.length <= 1)
		.map((err) => err.message)

	const itemErrorsMap = useMemo(() => {
		const map = new Map<number, string[]>()
		for (const err of errors ?? []) {
			if (err.dotPath.length <= 1) continue
			const idx = Number(err.dotPath[1])
			if (Number.isNaN(idx)) continue
			if (!map.has(idx)) map.set(idx, [])
			map.get(idx)!.push(err.message)
		}
		return map
	}, [errors])

	const updateItems = (next: unknown[]) => triggerFormEvents(inputProps, next)

	const usePicklistPicker =
		ep.valueMode === 'picklist' && ep.pickerMode === 'picker' && ep.picklist

	if (usePicklistPicker) {
		return (
			<FieldChrome
				{...cleanProps({
					label: formBaseInfo.label,
					required: formBaseInfo.required,
					description: formBaseInfo.description,
					helperText: formBaseInfo.helperText,
					hint: formBaseInfo.hint,
					tooltip: formBaseInfo.tooltip,
					badge: formBaseInfo.badge,
					errors: baseErrors,
				})}
			>
				<PicklistControl
					meta={{
						clearable: ep.picklist?.clearable ?? true,
						allowCreate: ep.picklist?.allowCreate ?? false,
						variant: ep.picklist?.variant ?? 'select',
						multiple: true,
						...cleanProps({
							options: ep.picklist?.options,
							entries: ep.picklist?.entries,
							labels: ep.picklist?.labels,
							disabled: ep.picklist?.disabled,
							placeholder: ep.picklist?.placeholder,
							searchable: ep.picklist?.searchable,
							maxSelections: ep.picklist?.maxValues,
							nothingFoundLabel: ep.picklist?.nothingFoundLabel,
						}),
					} as any}
					value={items}
					onChange={(next) => {
						if (Array.isArray(next)) updateItems(next)
						else if (next == null) updateItems([])
						else updateItems([next])
					}}
					disabled={inputProps.disabled ?? false}
					required={false}
				/>
			</FieldChrome>
		)
	}

	const handleAdd = () => {
		const template = ep.defaultItem ?? defaultByMode(ep.valueMode ?? 'auto', ep.picklist?.options)

		updateItems([...items, cloneValue(template)])
	}

	const handleRemove = (index: number) => {
		if (!canRemove || inputProps.disabled) return
		if (items.length <= minItems) return
		const next = items.filter((_, idx) => idx !== index)
		updateItems(next)
	}

	const handleMove = (index: number, direction: number) => {
		if (!canReorder || inputProps.disabled) return
		const target = index + direction
		updateItems(reorderList(items, index, target))
	}

	const handleChange = (index: number, nextValue: unknown) => {
		const next = [...items]
		next[index] = nextValue
		updateItems(next)
	}

	type ControlRenderResult = { node: ReactNode; inline?: boolean }

	const renderControl = (index: number, current: unknown): ControlRenderResult => {
		const mode = inferMode(ep.valueMode, current)
		switch (mode) {
			case 'number':
				return {
					node: (
						<NumberInput
							value={typeof current === 'number' ? current : ''}
							onChange={(val) => {
								const parsed = val === '' || val === undefined ? undefined : Number(val)
								handleChange(index, parsed ?? 0)
							}}
							disabled={inputProps.disabled ?? false}
						/>
					),
				}
			case 'boolean':
				return {
					inline: true,
					node: (
						<Switch
							label={`${itemLabel} #${index + 1}`}
							checked={Boolean(current)}
							onChange={(event) => {
								handleChange(index, (event.currentTarget as HTMLInputElement).checked)
							}}
							disabled={inputProps.disabled ?? false}
						/>
					),
				}
			case 'json': {
				const formatted =
					current && typeof current === 'object'
						? JSON.stringify(current, null, 2)
						: typeof current === 'string'
							? current
							: '{}'
				return {
					node: (
						<Textarea
							key={`${index}-${items.length}-${typeof current === 'object' ? JSON.stringify(current) : current}`}
							defaultValue={formatted}
							minRows={4}
							autosize
							onBlur={(event) => {
								const value = (event.currentTarget as HTMLTextAreaElement).value
								try {
									const parsed = JSON.parse(value || '{}')
									handleChange(index, parsed)
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
							styles={{
								input: { fontFamily: 'var(--mantine-font-family-monospace)' },
							}}
						/>
					),
				}
			}
			case 'picklist': {
				const currentId = current == null ? null : idOf(current as string | number)
				return {
					node: (
						<Select
							data={pickMeta.data}
							value={currentId ?? null}
							onChange={(id) => {
								if (id === null) return handleChange(index, null)
								const raw = pickMeta.map.get(id!) ?? (pickMeta.isAllNumbers ? Number(id) : id)
								handleChange(index, raw)
							}}
							disabled={inputProps.disabled ?? false}
							{...cleanProps({
								placeholder: ep.picklist?.placeholder,
								clearable: ep.picklist?.clearable,
								searchable: ep.picklist?.searchable,
							})}
						/>
					),
				}
			}
			default:
				return {
					node: (
						<TextInput
							value={typeof current === 'string' ? current : current == null ? '' : String(current)}
							onChange={(event) => {
								handleChange(index, (event.currentTarget as HTMLInputElement).value)
							}}
							disabled={inputProps.disabled ?? false}
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
						disabled={idx === 0 || (inputProps.disabled ?? false)}
						aria-label="上移"
					>
						<IconArrowUp size={16} />
					</ActionIcon>
					<ActionIcon
						variant="subtle"
						onClick={() => handleMove(idx, 1)}
						disabled={idx === items.length - 1 || (inputProps.disabled ?? false)}
						aria-label="下移"
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
					disabled={(inputProps.disabled ?? false) || items.length <= minItems}
					aria-label="删除"
				>
					<IconTrash size={16} />
				</ActionIcon>
			) : null}
		</Group>
	)

	const renderErrors = (idx: number) => {
		const combined = [
			...(itemErrorsMap.get(idx) ?? []),
			jsonParseErrors[idx] ?? undefined,
		].filter(Boolean) as string[]
		if (!combined.length) return null
		return (
			<Text size="xs" c="red.6">
				{combined.join(', ')}
			</Text>
		)
	}

	const renderItemCard = (item: unknown, idx: number) => {
		const control = renderControl(idx, item)
		const inline = reorderEnabled ? false : control.inline
		const errorsNode = renderErrors(idx)
		const actionsNode = (
			<Group gap="xs" align="center">
				{canReorder ? <IconGripVertical size={16} style={{ cursor: 'grab', opacity: 0.75 }} /> : null}
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
							{node}
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
	const reorderEnabled = canReorder && items.length > 1
	const [activeId, setActiveId] = useState<UniqueIdentifier | null>(null)

	const renderedCards = items.map((item, idx) => ({ ...renderItemCard(item, idx), id: `item-${idx}` as const }))
	const inlineCards = renderedCards.filter((item) => item.inline)
	const blockCards = renderedCards.filter((item) => !item.inline)

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
		reorderEnabled ? (
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
					updateItems(reorderList(items, from, to))
				}}
				onDragCancel={() => setActiveId(null)}
			>
				<SortableContext items={renderedCards.map((item) => item.id)} strategy={rectSortingStrategy}>
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
		items.length === 0 ? (
			<Card withBorder shadow="xs" p="md">
				<Text size="sm" c="dimmed">
					{ep.emptyHint ?? DEFAULT_TEXTS.array.emptyHint}
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
				label: formBaseInfo.label,
				required: formBaseInfo.required,
				description: formBaseInfo.description,
				helperText: formBaseInfo.helperText,
				hint: formBaseInfo.hint,
				tooltip: formBaseInfo.tooltip,
				badge: formBaseInfo.badge,
				errors: baseErrors,
			})}
		>
			<Stack gap="md">
				{itemsNode}
				{canAdd ? (
					<Button
						leftSection={<IconPlus size={16} />}
						variant="light"
						onClick={handleAdd}
						disabled={inputProps.disabled ?? false}
					>
						{ep.addLabel ?? DEFAULT_TEXTS.array.addItem}
					</Button>
				) : null}
			</Stack>
		</FieldChrome>
	)
}

registerRenderer(META_MAP.ARRAY, (props) => <ArrayField {...(props as RendererProps)} />)
