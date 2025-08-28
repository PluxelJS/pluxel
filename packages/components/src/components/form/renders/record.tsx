import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	MeasuringStrategy,
	PointerSensor,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	arrayMove,
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
	NumberInput,
	Paper,
	rem,
	Stack,
	Switch,
	Table,
	Text,
	Textarea,
	TextInput,
	Tooltip,
} from '@mantine/core'
import { IconGripVertical, IconPlus, IconTrash } from '@tabler/icons-react'
import React, { memo, useCallback, useMemo, useRef, useState } from 'react'
import { META_MAP, registerRenderer, triggerFormEvents } from 'valibot-form'

/* -------------------------------- Types -------------------------------- */
export type RecordUI = {
	addable?: true
	removable?: true
	reorderable?: true
	editableKey?: boolean
	asTable?: true
	columns?: { key?: number | string; value?: number | string }
	keyPlaceholder?: string
	valuePlaceholder?: string
	emptyHint?: string
	valueMode?: 'auto' | 'string' | 'number' | 'boolean' | 'json'
}

type RendererProps = {
	formBaseInfo: any
	/** dotPath[0]=字段名；dotPath[1]=record 的 key */
	errors?: { message: string; dotPath: string[] }[]
	extractedPropsInfo?: RecordUI
	inputProps: {
		name?: string
		onChange?: (v: Record<string, unknown>) => void
		onBlur?: (evt?: any) => void
		disabled?: boolean
	}
	value?: Record<string, unknown> // 仅用于初始值（或 name 变化时重建）
}

type RowData = { id: string; k: string; v: unknown }

/* -------------------------------- Utils -------------------------------- */
let __rid = 0
const rid = () => `row_${++__rid}`

const isShortText = (v: unknown) => typeof v === 'string' && v.length <= 60 && !/\n/.test(v)
const looksLikeJson = (s: string) => {
	const t = s.trim()
	if (!t) return false
	const like = (t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))
	if (!like) return false
	try {
		JSON.parse(t)
		return true
	} catch {
		return false
	}
}
const pickDefaultByMode = (mode: NonNullable<RecordUI['valueMode']>): unknown => {
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
const inferKind = (v: unknown): 'string' | 'number' | 'boolean' | 'json' => {
	if (typeof v === 'number') return 'number'
	if (typeof v === 'boolean') return 'boolean'
	if (typeof v === 'string' && looksLikeJson(v)) return 'json'
	if (v && typeof v === 'object') return 'json'
	return 'string'
}

/* ---------------------------- Sortable Row ----------------------------- */
interface RowProps {
	row: RowData
	idx: number
	disabled?: boolean
	editableKey: boolean
	effectiveMode: 'auto' | 'string' | 'number' | 'boolean' | 'json'
	keyPlaceholder?: string
	valuePlaceholder?: string
	asTable?: boolean
	onCommit: (id: string, next: Partial<RowData>) => void
	onRemove: (id: string) => void
	keyWidth?: number | string
	valueWidth?: number | string
	/** 由上层按 key 聚合下沉（只显示到“值”控件） */
	valueError?: string[]
	setActiveId?: (id: string | null) => void
	reorderable: boolean
}

const Handle = React.forwardRef<HTMLButtonElement, React.ComponentProps<typeof ActionIcon>>(
	(props, ref) => (
		<ActionIcon
			ref={ref}
			variant="subtle"
			{...props}
			aria-label="拖拽排序"
			tabIndex={0}
			style={{ touchAction: 'none', cursor: 'grab' }}
		>
			<IconGripVertical size={16} />
		</ActionIcon>
	),
)
Handle.displayName = 'Handle'

const SortableRow = memo(function SortableRow(props: RowProps) {
	const {
		row,
		idx,
		disabled,
		editableKey,
		effectiveMode,
		keyPlaceholder,
		valuePlaceholder,
		asTable,
		onCommit,
		onRemove,
		keyWidth,
		valueWidth,
		valueError,
		setActiveId,
		reorderable,
	} = props

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
		disabled: !reorderable,
	})

	const style = {
		transform: CSS.Transform.toString(transform),
		transition,
		opacity: isDragging ? 0.6 : 1,
	} as React.CSSProperties

	const keyRef = useRef<HTMLInputElement | null>(null)
	const textRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
	const numRef = useRef<number | null>(typeof row.v === 'number' ? (row.v as number) : null)
	const [boolVis, setBoolVis] = useState<boolean>(
		typeof row.v === 'boolean' ? (row.v as boolean) : false,
	)

	const kind: 'string' | 'number' | 'boolean' | 'json' =
		effectiveMode === 'auto' ? inferKind(row.v) : effectiveMode

	const commit = useCallback(() => {
		const next: Partial<RowData> = {}
		if (editableKey) next.k = keyRef.current?.value ?? row.k

		switch (kind) {
			case 'number':
				next.v = numRef.current ?? 0
				break
			case 'boolean':
				next.v = boolVis
				break
			case 'json': {
				const s = (textRef.current as HTMLTextAreaElement | HTMLInputElement)?.value ?? ''
				try {
					next.v = JSON.parse(s)
				} catch {
					next.v = s
				}
				break
			}
			default:
				next.v = (textRef.current as HTMLTextAreaElement | HTMLInputElement)?.value ?? ''
		}
		onCommit(row.id, next)
	}, [editableKey, onCommit, row.id, row.k, boolVis, kind])

	const onKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === 'Enter' && !e.shiftKey && kind !== 'json') {
			e.preventDefault()
			commit()
		}
	}

	const keyCell = (
		<TextInput
			ref={keyRef}
			defaultValue={row.k}
			placeholder={keyPlaceholder ?? '键名'}
			disabled={disabled || !editableKey}
			onBlur={commit}
			onKeyDown={onKeyDown}
			styles={{ input: { width: keyWidth ?? 'auto' } }}
		/>
	)

	const renderValueField = () => {
		if (kind === 'number') {
			return (
				<NumberInput
					defaultValue={typeof row.v === 'number' ? row.v : undefined}
					disabled={disabled}
					hideControls
					allowDecimal
					onChange={(n) => (numRef.current = typeof n === 'number' ? n : null)}
					onBlur={commit}
					error={valueError?.[0]}
					styles={{ input: { width: valueWidth ?? rem(160) } }}
				/>
			)
		}
		if (kind === 'boolean') {
			return (
				<Stack gap={4}>
					<Group gap="xs" align="center">
						<Switch
							defaultChecked={Boolean(row.v)}
							onChange={(e) => {
								const checked = e.currentTarget.checked
								setBoolVis(checked)
								onCommit(row.id, { v: checked }) // 即时提交，避免视觉不同步
							}}
							disabled={disabled}
							onBlur={commit}
						/>
						<Badge variant="light" size="sm" color={boolVis ? 'green' : 'gray'}>
							{boolVis ? '开启' : '关闭'}
						</Badge>
					</Group>
					{valueError?.length ? (
						<Text c="red" size="xs">
							{valueError.join(', ')}
						</Text>
					) : null}
				</Stack>
			)
		}
		if (kind === 'json') {
			const dv = typeof row.v === 'string' ? row.v : JSON.stringify(row.v ?? {}, null, 0)
			return (
				<Textarea
					ref={(el) => (textRef.current = el)}
					defaultValue={dv}
					autosize
					minRows={1}
					maxRows={6}
					placeholder={valuePlaceholder ?? 'JSON 值'}
					disabled={disabled}
					onBlur={commit}
					onKeyDown={onKeyDown}
					error={valueError?.[0]}
					styles={{ input: { width: valueWidth ?? 'auto' } }}
				/>
			)
		}
		// string
		const dv = typeof row.v === 'string' ? row.v : String(row.v ?? '')
		const asShort = isShortText(dv)
		const Comp = asShort ? TextInput : Textarea
		return (
			<Comp
				ref={(el: any) => (textRef.current = el)}
				defaultValue={dv}
				{...(asShort ? {} : { autosize: true, minRows: 1, maxRows: 6 })}
				placeholder={valuePlaceholder ?? '值'}
				disabled={disabled}
				onBlur={commit}
				onKeyDown={onKeyDown}
				error={valueError?.[0]}
				styles={{ input: { width: valueWidth ?? 'auto' } }}
			/>
		)
	}

	const removeBtn = (
		<Tooltip label={`删除第 ${idx + 1} 行`}>
			<ActionIcon
				variant="subtle"
				color="red"
				onClick={() => onRemove(row.id)}
				disabled={disabled}
				aria-label={`删除第 ${idx + 1} 行`}
			>
				<IconTrash size={16} />
			</ActionIcon>
		</Tooltip>
	)

	/** 关键：不要再覆写 onPointerDown，避免覆盖 dnd-kit 的 activator 监听器 */
	const handleBtn = (
		<Handle
			{...attributes}
			{...listeners}
			ref={setActivatorNodeRef}
			aria-roledescription="拖拽把手"
		/>
	)

	if (asTable) {
		return (
			<tr ref={setNodeRef} style={style}>
				<td style={{ width: rem(36) }}>{handleBtn}</td>
				<td style={{ width: keyWidth }}>{keyCell}</td>
				<td style={{ width: valueWidth }}>{renderValueField()}</td>
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
			<Group align="flex-start" wrap="nowrap">
				{handleBtn}
				<Stack gap={6} style={{ flex: 1 }}>
					<Group justify="space-between" gap="xs" wrap="nowrap">
						<div style={{ flex: 1 }}>{keyCell}</div>
						{removeBtn}
					</Group>
					{renderValueField()}
				</Stack>
			</Group>
		</Paper>
	)
})

/* ------------------------------- Main ---------------------------------- */
function RecordRendererImpl(props: RendererProps) {
	const { errors, extractedPropsInfo, inputProps, value } = props

	const ep: Required<
		Pick<
			RecordUI,
			'addable' | 'removable' | 'reorderable' | 'editableKey' | 'asTable' | 'valueMode'
		>
	> &
		Pick<RecordUI, 'columns' | 'keyPlaceholder' | 'valuePlaceholder' | 'emptyHint'> = {
		addable: true,
		removable: true,
		reorderable: true,
		editableKey: true,
		asTable: true,
		valueMode: 'auto',
		columns: undefined,
		keyPlaceholder: '键名',
		valuePlaceholder: '值',
		emptyHint: '暂无数据，点击下方“添加一行”',
		...extractedPropsInfo,
	}

	const keyWidth = useMemo(
		() => (typeof ep.columns?.key === 'number' ? rem(ep.columns!.key as number) : ep.columns?.key),
		[ep.columns?.key],
	)
	const valueWidth = useMemo(
		() =>
			typeof ep.columns?.value === 'number' ? rem(ep.columns!.value as number) : ep.columns?.value,
		[ep.columns?.value],
	)

	// —— 错误下沉：严格匹配当前字段名 + key —— //
	const { topLevelErrorText, perKeyValueErrors } = useMemo(() => {
		const per = new Map<string, string[]>()
		const top: string[] = []
		const fieldName = props.inputProps.name
		for (const e of errors ?? []) {
			if (!e?.dotPath?.length) continue
			if (fieldName && e.dotPath[0] !== fieldName) continue // 只收自己字段的错误
			const key = e.dotPath[1]
			if (!key) top.push(e.message)
			else per.set(key, (per.get(key) ?? []).concat(e.message))
		}
		return { topLevelErrorText: top.join(', '), perKeyValueErrors: per }
	}, [errors, props.inputProps.name])

	// —— 初始化（仅首渲染或 name 变化）—— //
	const initialRows = useMemo<RowData[]>(() => {
		const obj = value ?? {}
		return Object.entries(obj).map(([k, v]) => ({ id: rid(), k, v }))
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [inputProps.name])

	const [rows, setRows] = useState<RowData[]>(initialRows)
	const [activeId, setActiveId] = useState<string | null>(null)

	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)

	const emitChange = useCallback(
		(nextRows: RowData[]) => {
			const obj: Record<string, unknown> = {}
			for (const r of nextRows) if (r.k) obj[r.k] = r.v
			triggerFormEvents?.(inputProps as any, obj)
		},
		[inputProps],
	)

	const ensureUniqueKey = useCallback((nextKey: string, selfId: string, pool: RowData[]) => {
		if (!nextKey) return nextKey
		const taken = new Set(pool.filter((r) => r.id !== selfId).map((r) => r.k))
		if (!taken.has(nextKey)) return nextKey
		let i = 2
		let k = `${nextKey} (${i})`
		while (taken.has(k)) {
			i += 1
			k = `${nextKey} (${i})`
		}
		return k
	}, [])

	const onCommit = useCallback(
		(id: string, next: Partial<RowData>) => {
			setRows((prev) => {
				const idx = prev.findIndex((r) => r.id === id)
				if (idx === -1) return prev
				const draft = [...prev]
				const cur = draft[idx]
				const merged: RowData = { ...cur, ...next }
				if (ep.editableKey && next.k !== undefined) {
					merged.k = ensureUniqueKey(next.k, id, draft)
				}
				draft[idx] = merged
				emitChange(draft)
				return draft
			})
		},
		[emitChange, ensureUniqueKey, ep.editableKey],
	)

	const onRemove = useCallback(
		(id: string) => {
			setRows((prev) => {
				const next = prev.filter((r) => r.id !== id)
				emitChange(next)
				return next
			})
		},
		[emitChange],
	)

	const addRow = useCallback(() => {
		setRows((prev) => {
			const base = 'key'
			const taken = new Set(prev.map((r) => r.k))
			let i = prev.length + 1
			let k = `${base}-${i}`
			while (taken.has(k)) {
				i += 1
				k = `${base}-${i}`
			}
			const id = rid()
			const v = pickDefaultByMode(ep.valueMode)
			const next = [...prev, { id, k, v }]
			emitChange(next)
			return next
		})
	}, [emitChange, ep.valueMode])

	const onDragStart = useCallback((evt: DragStartEvent) => setActiveId(String(evt.active.id)), [])
	const onDragEnd = useCallback(
		(evt: DragEndEvent) => {
			setActiveId(null)
			if (!ep.reorderable) return
			const { active, over } = evt
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

	const header = ep.asTable ? (
		<Table.Thead>
			<Table.Tr>
				<Table.Th style={{ width: rem(36) }}>排序</Table.Th>
				<Table.Th style={{ width: keyWidth }}>键</Table.Th>
				<Table.Th style={{ width: valueWidth }}>值</Table.Th>
				<Table.Th style={{ width: rem(60) }}>操作</Table.Th>
			</Table.Tr>
		</Table.Thead>
	) : null

	return (
		<Stack gap="xs">
			{rows.length === 0 && (
				<Tooltip label={ep.emptyHint} position="top-start" openDelay={300}>
					<Text c="dimmed" size="sm">
						{ep.emptyHint}
					</Text>
				</Tooltip>
			)}

			<DndContext
				sensors={sensors}
				onDragStart={onDragStart}
				onDragEnd={onDragEnd}
				collisionDetection={closestCenter}
				measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
				modifiers={[restrictToVerticalAxis]}
			>
				{ep.asTable ? (
					<Table striped withTableBorder withColumnBorders highlightOnHover>
						{header}
						<Table.Tbody>
							<SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
								{rows.map((r, i) => (
									<SortableRow
										key={r.id}
										row={r}
										idx={i}
										disabled={inputProps.disabled}
										editableKey={!!ep.editableKey}
										effectiveMode={ep.valueMode ?? 'auto'}
										keyPlaceholder={ep.keyPlaceholder}
										valuePlaceholder={ep.valuePlaceholder}
										asTable
										onCommit={onCommit}
										onRemove={onRemove}
										keyWidth={keyWidth}
										valueWidth={valueWidth}
										valueError={perKeyValueErrors.get(r.k)}
										setActiveId={setActiveId}
										reorderable={!!ep.reorderable}
									/>
								))}
							</SortableContext>
						</Table.Tbody>
					</Table>
				) : (
					<SortableContext items={rows.map((r) => r.id)} strategy={verticalListSortingStrategy}>
						<Stack gap="sm">
							{rows.map((r, i) => (
								<SortableRow
									key={r.id}
									row={r}
									idx={i}
									disabled={inputProps.disabled}
									editableKey={!!ep.editableKey}
									effectiveMode={ep.valueMode ?? 'auto'}
									keyPlaceholder={ep.keyPlaceholder}
									valuePlaceholder={ep.valuePlaceholder}
									asTable={false}
									onCommit={onCommit}
									onRemove={onRemove}
									keyWidth={keyWidth}
									valueWidth={valueWidth}
									valueError={perKeyValueErrors.get(r.k)}
									setActiveId={setActiveId}
									reorderable={!!ep.reorderable}
								/>
							))}
						</Stack>
					</SortableContext>
				)}

				<DragOverlay dropAnimation={{ duration: 150 }}>
					{overlayRow ? (
						<Paper
							withBorder
							p="xs"
							radius="md"
							style={{ background: 'var(--mantine-color-body)' }}
						>
							<Group gap="sm" wrap="nowrap">
								<IconGripVertical size={16} />
								<Text size="sm" fw={500} lineClamp={1}>
									{overlayRow.k}
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
						onClick={addRow}
						disabled={inputProps.disabled}
					>
						添加一行
					</Button>
				)}
			</Group>
		</Stack>
	)
}

/* ------------------------------ Register ------------------------------- */
registerRenderer(META_MAP.RECORD, (props: RendererProps) => <RecordRendererImpl {...props} />)
