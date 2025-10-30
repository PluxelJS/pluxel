import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { restrictToParentElement, restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	arrayMove,
	rectSortingStrategy,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { CSS } from '@dnd-kit/utilities'
import {
	ActionIcon,
	Badge,
	Button,
	Group,
	MultiSelect,
	NumberInput,
	Paper,
	rem,
	Select,
	SimpleGrid,
	Stack,
	Switch,
	Table,
	Text,
	TextInput,
	Tooltip,
} from '@mantine/core'
import { IconGripVertical, IconMinus, IconPlus } from '@tabler/icons-react'
import React, { memo, useCallback, useMemo, useRef, useState } from 'react'
import { registerRenderer, triggerFormEvents } from '~/registry'
import { META_MAP } from '~/utils'

/* ------------------------------- Types ------------------------------- */
export type ArrayUI<T extends string | number = string | number> = {
	addable?: true
	removable?: true
	reorderable?: true
	style?: 'list' | 'grid' | 'table'
	columns?: number
	itemLabel?: string
	defaultItem?: unknown
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json' | 'picklist'
	/** 当 valueMode === 'picklist' 时启用 MultiSelect（默认一切合理默认） */
	picklist?: {
		options: readonly T[]
		labels?: Partial<Record<T, string>>
		disabled?: readonly T[]
		placeholder?: string
		searchable?: true // 覆盖智能默认
		clearable?: true // 覆盖智能默认
		maxValues?: number // 覆盖智能默认
		limit?: number // 覆盖智能默认
	}
}

type RendererProps = {
	formBaseInfo: any
	// dotPath[0] = 字段名；dotPath[1] = "索引"（字符串）
	errors?: { message: string; dotPath: string[] }[]
	extractedPropsInfo?: ArrayUI
	inputProps: {
		name?: string
		onChange?: (v: unknown[]) => void
		onBlur?: (evt?: any) => void
		disabled?: boolean
	}
	value?: unknown[] // 仅作初始值
}

type RowData = { id: string; v: unknown }

/* -------------------------- Utilities -------------------------- */
let __rid = 0
const rid = () => `row_${++__rid}`

const isShortText = (v: unknown) => typeof v === 'string' && v.length <= 60 && !/\n/.test(v)

const coerceAuto = (raw: string): unknown => {
	const t = raw.trim()
	if (t === 'true') return true
	if (t === 'false') return false
	if (t === 'null') return null
	if (/^[-+]?\d+(?:\.\d+)?$/.test(t)) return Number(t)
	try {
		if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
			return JSON.parse(t)
		}
	} catch {}
	return raw
}

const pickDefaultByMode = (
	mode: NonNullable<ArrayUI['valueMode']>,
	pickOpts?: readonly (string | number)[],
): unknown => {
	if (mode === 'picklist') return pickOpts?.[0] ?? ''
	switch (mode) {
		case 'number':
			return 0
		case 'boolean':
			return false
		case 'json':
			return {}
		case 'string':
			return ''
		default:
			return ''
	}
}

/* ---------- picklist helpers（label/禁用/类型保真） ---------- */
const idOf = (v: string | number) => String(v)
function buildPickData(
	opts: readonly (string | number)[] = [],
	labels?: Partial<Record<string | number, string>>,
	disabled?: readonly (string | number)[],
) {
	const idToRaw = new Map<string, string | number>()
	const dis = new Set((disabled ?? []).map((v) => String(v)))
	const data = opts.map((raw) => {
		const id = idOf(raw)
		idToRaw.set(id, raw)
		return {
			value: id,
			label: (labels as any)?.[raw] ?? String(raw),
			disabled: dis.has(id),
		}
	})
	const isAllNumbers = opts.length > 0 && opts.every((x) => typeof x === 'number')
	return { data, idToRaw, isAllNumbers }
}

/* ----------------------------- SortableItem ---------------------------- */
interface ItemProps {
	row: RowData
	idx: number
	disabled?: boolean
	mode: NonNullable<ArrayUI['valueMode']>
	label?: string
	styleKind: NonNullable<ArrayUI['style']>
	itemError?: string[] // 每项错误
	onCommit: (id: string, next: Partial<RowData>) => void
	onRemove: (id: string) => void
}

const Handle = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof ActionIcon>>(
	(props, ref) => (
		<ActionIcon
			ref={ref}
			variant="subtle"
			{...props}
			aria-label="拖拽排序"
			style={{ cursor: 'grab' }}
		>
			<IconGripVertical size={16} />
		</ActionIcon>
	),
)
Handle.displayName = 'Handle'

const SortableItem = memo(function SortableItem(props: ItemProps) {
	const { row, idx, disabled, mode, label, styleKind, onCommit, onRemove, itemError } = props
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: row.id,
	})

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.6 : 1,
	} as React.CSSProperties

	const tRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
	const nRef = useRef<number | null>(typeof row.v === 'number' ? (row.v as number) : null)
	const [bVis, setBVis] = useState<boolean>(typeof row.v === 'boolean' ? (row.v as boolean) : false)

	const commit = useCallback(() => {
		const next: Partial<RowData> = {}
		switch (mode) {
			case 'number':
				next.v = nRef.current ?? 0
				break
			case 'boolean':
				next.v = bVis
				break
			case 'json': {
				const raw = (tRef.current as any)?.value ?? ''
				try {
					next.v = JSON.parse(raw)
				} catch {
					next.v = raw
				}
				break
			}
			default: {
				if (tRef.current) next.v = coerceAuto((tRef.current as any).value)
				else if (nRef.current !== null) next.v = nRef.current
				else next.v = bVis
			}
		}
		onCommit(row.id, next)
	}, [mode, onCommit, row.id, bVis])

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault()
			commit()
		}
	}

	const removeBtn = (
		<Tooltip label={`删除第 ${idx + 1} 项`}>
			<ActionIcon variant="subtle" color="red" onClick={() => onRemove(row.id)} disabled={disabled}>
				<IconMinus size={16} />
			</ActionIcon>
		</Tooltip>
	)

	const renderInput = () => {
		if (mode === 'number' || typeof row.v === 'number') {
			return (
				<NumberInput
					defaultValue={typeof row.v === 'number' ? (row.v as number) : undefined}
					hideControls
					allowDecimal
					onChange={(n) => (nRef.current = typeof n === 'number' ? n : null)}
					onBlur={commit}
					disabled={disabled}
					error={itemError?.[0]}
				/>
			)
		}
		if (mode === 'boolean' || typeof row.v === 'boolean') {
			return (
				<Stack gap={4}>
					<Group gap="xs" align="center">
						<Switch
							defaultChecked={Boolean(row.v)}
							onChange={(e) => {
								const checked = e.currentTarget.checked
								setBVis(checked)
								onCommit(row.id, { v: checked })
							}}
							onBlur={commit}
							disabled={disabled}
						/>
						<Badge variant="light" size="sm" color={bVis ? 'green' : 'gray'}>
							{bVis ? '开启' : '关闭'}
						</Badge>
					</Group>
					{itemError?.length ? (
						<Text c="red" size="xs">
							{itemError.join(', ')}
						</Text>
					) : null}
				</Stack>
			)
		}
		if (mode === 'json' || (typeof row.v === 'string' && /^\s*[[{]/.test(row.v))) {
			const def = typeof row.v === 'string' ? row.v : JSON.stringify(row.v)
			return (
				<TextInput
					ref={(el: any) => (tRef.current = el)}
					defaultValue={def}
					placeholder={label ?? 'JSON 值'}
					onBlur={commit}
					onKeyDown={onKeyDown}
					disabled={disabled}
					error={itemError?.[0]}
				/>
			)
		}
		// string / auto
		const dv = typeof row.v === 'string' ? row.v : String(row.v ?? '')
		const asShort = isShortText(dv)
		const Comp = asShort ? TextInput : (TextInput as any)
		return (
			<Comp
				ref={(el: any) => (tRef.current = el)}
				defaultValue={dv}
				placeholder={label ?? '请输入'}
				onBlur={commit}
				onKeyDown={onKeyDown}
				disabled={disabled}
				error={itemError?.[0]}
			/>
		)
	}

	const HandleBtn = (
		<Handle
			{...attributes}
			{...listeners}
			ref={setActivatorNodeRef}
			aria-roledescription="可拖拽项"
			aria-label="拖拽排序"
		/>
	)

	if (styleKind === 'table') {
		return (
			<tr ref={setNodeRef} style={style}>
				<td style={{ width: rem(36) }}>{HandleBtn}</td>
				<td>
					<Stack gap={4}>
						<Group gap="xs" wrap="nowrap">
							<Text c="dimmed" size="sm">
								#{idx + 1}
							</Text>
							<div style={{ flex: 1 }}>{renderInput()}</div>
						</Group>
						{itemError?.length ? (
							<Text c="red" size="xs">
								{itemError.join(', ')}
							</Text>
						) : null}
					</Stack>
				</td>
				<td style={{ width: rem(60) }}>
					<Group gap="xs" justify="flex-end">
						{removeBtn}
					</Group>
				</td>
			</tr>
		)
	}

	return (
		<Paper ref={setNodeRef as any} withBorder p="xs" radius="md" style={style}>
			<Group align="center" wrap="nowrap">
				{HandleBtn}
				<Stack gap={6} style={{ flex: 1 }}>
					<Group justify="space-between" gap="xs">
						<Text c="dimmed" size="sm">
							{label ?? '项目'} {idx + 1}
						</Text>
						{removeBtn}
					</Group>
					{renderInput()}
				</Stack>
			</Group>
		</Paper>
	)
})

/* ------------------------------ Main Widget（非受控） ------------------------------ */
function ArrayRendererImpl(props: RendererProps) {
	const { errors, extractedPropsInfo, inputProps, value } = props

	const ep: Required<
		Pick<
			ArrayUI,
			'addable' | 'removable' | 'reorderable' | 'style' | 'columns' | 'itemLabel' | 'valueMode'
		>
	> &
		Pick<ArrayUI, 'defaultItem' | 'picklist'> = {
		addable: true,
		removable: true,
		reorderable: true,
		style: 'table',
		columns: 3,
		itemLabel: '项目',
		valueMode: 'auto',
		...extractedPropsInfo,
	}

	/* ------ 错误分流：数组级别 vs 每项（按索引） ------ */
	const { topLevelErrorText, perItemErrors } = useMemo(() => {
		const per = new Map<number, string[]>()
		const top: string[] = []
		for (const e of errors ?? []) {
			const idxStr = e.dotPath?.[1]
			const idx = Number.isFinite(Number(idxStr)) ? Number(idxStr) : null
			if (idx === null) top.push(e.message)
			else per.set(idx, (per.get(idx) ?? []).concat(e.message))
		}
		return { topLevelErrorText: top.join(', '), perItemErrors: per }
	}, [errors])

	const strategy = ep.style === 'grid' ? rectSortingStrategy : verticalListSortingStrategy
	const modifiers = ep.style === 'grid' ? [restrictToParentElement] : [restrictToVerticalAxis]

	/* ------ 初始化（非受控） ------ */
	const initialRows = useMemo<RowData[]>(
		() => (Array.isArray(value) ? value : []).map((v) => ({ id: rid(), v })),
		// eslint-disable-next-line react-hooks/exhaustive-deps
		[inputProps.name],
	)
	const [rows, setRows] = useState<RowData[]>(initialRows)
	const [activeId, setActiveId] = useState<string | null>(null)

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)

	const emitChange = useCallback(
		(nextRows: RowData[]) => {
			const arr = nextRows.map((r) => r.v)
			triggerFormEvents?.(inputProps as any, arr)
		},
		[inputProps],
	)

	const onCommit = useCallback(
		(id: string, next: Partial<RowData>) => {
			setRows((prev) => {
				const idx = prev.findIndex((r) => r.id === id)
				if (idx === -1) return prev
				const draft = [...prev]
				draft[idx] = { ...draft[idx], ...next }
				emitChange(draft)
				return draft
			})
		},
		[emitChange],
	)

	const onRemove = useCallback(
		(id: string) => {
			setRows((prev) => {
				const draft = prev.filter((r) => r.id !== id)
				emitChange(draft)
				return draft
			})
		},
		[emitChange],
	)

	const onAdd = useCallback(() => {
		const pickOpts = ep.picklist?.options as readonly (string | number)[] | undefined
		setRows((prev) => {
			const nextItem = ep.defaultItem ?? pickDefaultByMode(ep.valueMode!, pickOpts)
			const next = [...prev, { id: rid(), v: nextItem }]
			emitChange(next)
			return next
		})
	}, [emitChange, ep.defaultItem, ep.valueMode, ep.picklist?.options])

	const onDragStart = useCallback((evt: DragStartEvent) => setActiveId(String(evt.active.id)), [])
	const onDragEnd = useCallback(
		(evt: DragEndEvent) => {
			if (!ep.reorderable) {
				setActiveId(null)
				return
			}
			const { active, over } = evt
			setActiveId(null)
			if (!over || active.id === over.id) return
			setRows((prev) => {
				const oldIndex = prev.findIndex((r) => r.id === active.id)
				const newIndex = prev.findIndex((r) => r.id === over.id)
				const next = arrayMove(prev, oldIndex, newIndex)
				emitChange(next)
				return next
			})
		},
		[emitChange, ep.reorderable],
	)

	const overlayRow = activeId ? rows.find((r) => r.id === activeId) : null

	/* ---------- picklist: 默认使用 MultiSelect 编辑整个数组 ---------- */
	if (ep.valueMode === 'picklist' && ep.picklist?.options?.length) {
		const pb = buildPickData(
			ep.picklist.options as any,
			ep.picklist.labels as any,
			ep.picklist.disabled as any,
		)
		const ids = useMemo(() => rows.map((r) => r.v).map(idOf), [rows])

		const optionCount = ep.picklist.options.length
		const searchable = ep.picklist.searchable ?? optionCount >= 8
		const clearable = ep.picklist.clearable ?? true
		const maxValues = ep.picklist.maxValues
		const limit = ep.picklist.limit

		const onMultiChange = (selIds: string[]) => {
			const nextVals = selIds.map((id) => pb.idToRaw.get(id) ?? (pb.isAllNumbers ? Number(id) : id))
			const next = nextVals.map((v) => ({ id: rid(), v }))
			setRows(next)
			emitChange(next)
		}

		// 聚合所有错误（MultiSelect 无逐项 error）
		const mergedError = [
			...(topLevelErrorText ? [topLevelErrorText] : []),
			...Array.from(perItemErrors.values()).flat(),
		].join(', ')

		return (
			<Stack gap="xs">
				<MultiSelect
					{...(inputProps as any)}
					data={pb.data}
					defaultValue={ids}
					onChange={onMultiChange}
					searchable={searchable}
					clearable={clearable}
					placeholder={ep.picklist.placeholder}
					maxValues={maxValues}
					limit={limit}
					maxDropdownHeight={200}
					error={mergedError || undefined}
					nothingFoundMessage={searchable ? '无匹配项' : undefined}
				/>
				{/* 如需“可增删项+排序”体验，请改用非 picklist 模式（rows+DND） */}
				{ep.addable === true && (
					<Group justify="flex-end">
						<Button
							leftSection={<IconPlus size={16} />}
							variant="light"
							onClick={() => onMultiChange(ids)}
							disabled // picklist 多选下“添加一项”无意义→禁用
						>
							添加一项
						</Button>
					</Group>
				)}
			</Stack>
		)
	}

	/* ---------- 非 picklist：保留原有 DnD 行编辑 ---------- */
	const listBody = (
		<SortableContext items={rows.map((r) => r.id)} strategy={strategy}>
			{ep.style === 'table' ? (
				<Table striped withTableBorder withColumnBorders highlightOnHover>
					<Table.Thead>
						<Table.Tr>
							<Table.Th style={{ width: rem(36) }}>排序</Table.Th>
							<Table.Th>值</Table.Th>
							<Table.Th style={{ width: rem(60) }}>操作</Table.Th>
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{rows.map((r, i) => (
							<SortableItem
								key={r.id}
								row={r}
								idx={i}
								disabled={inputProps.disabled}
								mode={ep.valueMode ?? 'auto'}
								label={ep.itemLabel}
								styleKind="table"
								onCommit={onCommit}
								onRemove={onRemove}
								itemError={perItemErrors.get(i)}
							/>
						))}
					</Table.Tbody>
				</Table>
			) : ep.style === 'grid' ? (
				<SimpleGrid cols={ep.columns ?? 3} spacing="xs">
					{rows.map((r, i) => (
						<SortableItem
							key={r.id}
							row={r}
							idx={i}
							disabled={inputProps.disabled}
							mode={ep.valueMode ?? 'auto'}
							label={ep.itemLabel}
							styleKind="list"
							onCommit={onCommit}
							onRemove={onRemove}
							itemError={perItemErrors.get(i)}
						/>
					))}
				</SimpleGrid>
			) : (
				<Stack gap="xs">
					{rows.map((r, i) => (
						<SortableItem
							key={r.id}
							row={r}
							idx={i}
							disabled={inputProps.disabled}
							mode={ep.valueMode ?? 'auto'}
							label={ep.itemLabel}
							styleKind="list"
							onCommit={onCommit}
							onRemove={onRemove}
							itemError={perItemErrors.get(i)}
						/>
					))}
				</Stack>
			)}
		</SortableContext>
	)

	return (
		<Stack gap="xs">
			{rows.length === 0 && (
				<Tooltip label="暂无数据，点击下方“添加一项”" position="top-start" openDelay={300}>
					<Text c="dimmed" size="sm">
						暂无数据，点击下方“添加一项”
					</Text>
				</Tooltip>
			)}

			<DndContext
				sensors={sensors}
				onDragStart={(e) => {
					setActiveId(String(e.active.id))
				}}
				onDragEnd={onDragEnd}
				collisionDetection={closestCenter}
				modifiers={modifiers}
			>
				{listBody}

				<DragOverlay dropAnimation={{ duration: 150 }}>
					{overlayRow ? (
						<Paper
							withBorder
							p="xs"
							radius="md"
							style={{ background: 'var(--mantine-color-body)' }}
						>
							<Group gap="sm">
								<IconGripVertical size={16} />
								<Text size="sm" fw={500} lineClamp={1}>
									{typeof overlayRow.v === 'string' ? overlayRow.v : JSON.stringify(overlayRow.v)}
								</Text>
							</Group>
						</Paper>
					) : null}
				</DragOverlay>
			</DndContext>

			<Group justify="space-between">
				<Group gap="xs">
					{topLevelErrorText && (
						<Text c="red" size="sm">
							{topLevelErrorText}
						</Text>
					)}
				</Group>
				{ep.addable && (
					<Button
						leftSection={<IconPlus size={16} />}
						variant="light"
						onClick={onAdd}
						disabled={inputProps.disabled}
					>
						添加一项
					</Button>
				)}
			</Group>
		</Stack>
	)
}

registerRenderer(META_MAP.ARRAY, (props: RendererProps) => (
	<ArrayRendererImpl {...(props as any)} />
))
