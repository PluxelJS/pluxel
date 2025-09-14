// src/components/PluginOrganizer.tsx
import {
	closestCenter,
	closestCorners,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	MeasuringStrategy,
	PointerSensor,
	type UniqueIdentifier,
	useDroppable,
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
import {
	ActionIcon,
	Anchor,
	Badge,
	Box,
	Card,
	Collapse,
	Divider,
	Group,
	Menu,
	Stack,
	Text,
	useMantineTheme,
} from '@mantine/core'
import {
	IconChevronDown,
	IconChevronRight,
	IconFolderPlus,
	IconGripVertical,
	IconPencil,
	IconTrash,
} from '@tabler/icons-react'
import type React from 'react'
import { memo, startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'

// ---------- types & utils ----------
const genGroupId = () =>
	globalThis.crypto?.randomUUID?.() ??
	`g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

export type PluginStatuses = { [name: string]: PluginStatus }
export interface PluginStatus {
	id: string
	name?: string
	isRunning: boolean
}
export interface GroupConfig {
	groupId: string
	name: string
	pluginIds: string[]
}

type Density = 'comfortable' | 'compact' | 'ultra'
const DENSITY: Record<Density, { rowH: number; px: number; py: number; font: 'xs' | 'sm' }> = {
	comfortable: { rowH: 38, px: 10, py: 8, font: 'sm' },
	compact: { rowH: 30, px: 8, py: 4, font: 'xs' },
	ultra: { rowH: 26, px: 6, py: 2, font: 'xs' },
}

type Props = {
	statuses: PluginStatuses
	initialGroups: GroupConfig[]
	onGroupsChange: (groups: GroupConfig[]) => void
	filterQuery?: string
	LinkComponent?: React.ComponentType<{ to: string; children: React.ReactNode }>
	activeId?: string | null
	activeIds?: string[]
	/** 紧凑度：默认 'compact' */
	density?: Density
}

// ---- id helpers（前缀化，避免冲突）----
const cid = (c: 'ROOT_UNGROUPED' | string) =>
	c === 'ROOT_UNGROUPED' ? 'c:ROOT' : (`c:${c}` as const)
const isCid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('c:')
const fromCid = (id: string): 'ROOT_UNGROUPED' | string =>
	id === 'c:ROOT' ? 'ROOT_UNGROUPED' : id.slice(2)

const iid = (p: string) => `i:${p}`
const isIid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('i:')
const fromIid = (id: string) => id.slice(2)

const gid = (g: string) => `g:${g}`
const isGid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('g:')
const fromGid = (id: string) => id.slice(2)

function sanitize(allIds: string[], groups: GroupConfig[]) {
	const seen = new Set<string>()
	const allow = new Set(allIds)
	const nextGroups = groups.map((g) => ({
		groupId: g.groupId,
		name: g.name,
		pluginIds: g.pluginIds
			.filter((id) => allow.has(id))
			.filter((id) => !seen.has(id) && (seen.add(id), true)),
	}))
	const ungrouped = allIds.filter((id) => !seen.has(id))
	return { groups: nextGroups, ungrouped }
}
const unique = (arr: string[]) => Array.from(new Set(arr))
const assertNoDup = (groups: GroupConfig[], ungrouped: string[]) => {
	if (process.env.NODE_ENV !== 'production') {
		const seen = new Map<string, number>()
		for (const id of ungrouped) seen.set(id, (seen.get(id) ?? 0) + 1)
		for (const g of groups) for (const id of g.pluginIds) seen.set(id, (seen.get(id) ?? 0) + 1)
		const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
		if (dup.length) console.warn('[PluginOrganizer] Duplicate ids detected:', dup)
	}
}

// ---------- Droppable（空容器也能投放） ----------
function DroppableContainer({
	id,
	children,
	disabled,
	minDropHeight = 0,
}: {
	id: UniqueIdentifier
	children: React.ReactNode
	disabled?: boolean
	minDropHeight?: number
}) {
	const { setNodeRef, isOver } = useDroppable({ id, disabled })
	return (
		<Box
			ref={setNodeRef}
			data-droppable-id={String(id)}
			style={{
				outline: isOver ? '1px dashed var(--mantine-color-blue-6)' : undefined,
				minHeight: minDropHeight,
			}}
		>
			{children}
		</Box>
	)
}

// ---------- 行（插件）：一行式，极简 ----------
const SortableRow = memo(function SortableRow({
	pid,
	name,
	running,
	selected,
	active,
	onRightSelect,
	LinkComp,
	disabled,
	dh,
}: {
	pid: string
	name: string
	running?: boolean
	selected: boolean
	active: boolean
	onRightSelect: (e: React.MouseEvent, pid: string) => void
	LinkComp?: React.ComponentType<{ to: string; children: React.ReactNode }>
	disabled: boolean
	dh: { rowH: number; px: number; py: number; font: 'xs' | 'sm' }
}) {
	const theme = useMantineTheme()
	const rowRef = useRef<HTMLAnchorElement | HTMLSpanElement | null>(null)

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: iid(pid),
		disabled,
		animateLayoutChanges: () => false,
	})

	const href = `/plugins/${pid}`

	return (
		<Box
			ref={setNodeRef}
			onDoubleClick={() => (rowRef.current as HTMLAnchorElement | null)?.click?.()}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onRightSelect(e, pid)
			}}
			// 只有这一层参与 dnd 度量与 transform，确保“对得准”
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition,
				opacity: isDragging ? 0.9 : 1,
				height: dh.rowH,
				padding: `${dh.py}px ${dh.px}px`,
				display: 'flex',
				alignItems: 'center', // 垂直居中关键
				gap: 8,
				borderRadius: 6,
				cursor: disabled ? 'default' : 'pointer',
				userSelect: 'none',
				background: active ? theme.colors.indigo[0] : selected ? theme.colors.blue[0] : undefined,
				borderBottom: `1px solid ${theme.colors.gray[2]}`, // 用边框，不再额外插“分隔线元素”
				boxSizing: 'border-box',
			}}
			data-po-row="1"
			data-selected={selected || undefined}
			data-active={active || undefined}
		>
			{/* 活动态左边细条 */}
			{active && (
				<Box
					aria-hidden
					style={{
						width: 2,
						alignSelf: 'stretch',
						background: theme.colors.indigo[6],
						borderTopLeftRadius: 6,
						borderBottomLeftRadius: 6,
					}}
				/>
			)}

			{/* drag handle */}
			<ActionIcon
				variant="subtle"
				title="拖拽排序"
				aria-label="拖拽排序"
				data-drag-handle
				style={{
					width: 20,
					height: 20,
					flex: '0 0 20px',
					touchAction: 'none',
					cursor: isDragging ? 'grabbing' : 'grab',
				}}
				{...listeners}
				{...attributes}
			>
				<IconGripVertical size={16} />
			</ActionIcon>

			{/* 名称（自适应截断） */}
			<Box style={{ flex: 1, minWidth: 0 }}>
				{LinkComp ? (
					<LinkComp to={href}>
						<Text
							ref={rowRef as any}
							size={dh.font}
							style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
							aria-current={active ? 'page' : undefined}
						>
							{name}
						</Text>
					</LinkComp>
				) : (
					<Anchor
						ref={rowRef as any}
						size={dh.font}
						href={href}
						underline="never"
						style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
						aria-current={active ? 'page' : undefined}
					>
						{name}
					</Anchor>
				)}
			</Box>

			{/* 状态：点 + 文案，天然垂直居中 */}
			{typeof running === 'boolean' && (
				<Group gap={6} wrap="nowrap">
					<Box
						component="span"
						aria-hidden
						style={{
							width: 6,
							height: 6,
							borderRadius: 6,
							background: running ? theme.colors.green[6] : theme.colors.gray[5],
						}}
					/>
					<Text size="xs" c="dimmed">
						{running ? '运行' : '停止'}
					</Text>
				</Group>
			)}
		</Box>
	)
})

// ---------- 组卡片：单行组头 + 极简列表 ----------
const GroupCard = memo(function GroupCard(props: {
	g: GroupConfig
	visibleIds: string[]
	runningSet: Set<string>
	selectedSet: Set<string>
	activeSet: Set<string>
	onRightSelect: (e: React.MouseEvent, id: string) => void
	LinkComp?: React.ComponentType<{ to: string; children: React.ReactNode }>
	sortableId: UniqueIdentifier
	onContextMenu: (e: React.MouseEvent) => void
	isFiltering: boolean
	isCollapsed: boolean
	toggleCollapse: () => void
	getName: (id: string) => string
	dh: { rowH: number; px: number; py: number; font: 'xs' | 'sm' }
}) {
	const {
		g,
		visibleIds,
		runningSet,
		selectedSet,
		activeSet,
		onRightSelect,
		LinkComp,
		sortableId,
		onContextMenu,
		isFiltering,
		isCollapsed,
		toggleCollapse,
		getName,
		dh,
	} = props

	const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
		id: sortableId,
		disabled: isFiltering,
		animateLayoutChanges: () => false,
	})

	const stat = {
		total: visibleIds.length,
		running: visibleIds.filter((id) => runningSet.has(id)).length,
	}

	return (
		<Card
			ref={setNodeRef}
			withBorder
			radius="md"
			p="sm"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition,
			}}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onContextMenu(e)
			}}
		>
			<Group justify="space-between" align="center" wrap="nowrap">
				<Group gap="xs" align="center" wrap="nowrap">
					<ActionIcon
						size="sm"
						variant="subtle"
						title="拖拽分组"
						aria-label="拖拽分组"
						data-drag-handle
						style={{ width: 26, height: 26, touchAction: 'none', cursor: 'grab' }}
						{...listeners}
						{...attributes}
					>
						<IconGripVertical size={16} />
					</ActionIcon>

					<ActionIcon size="xs" variant="subtle" onClick={toggleCollapse} aria-label="切换折叠">
						{isCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
					</ActionIcon>

					<Text fw={600} size="sm" style={{ whiteSpace: 'nowrap' }}>
						{g.name}
					</Text>
					<Text size="xs" c="dimmed" style={{ whiteSpace: 'nowrap' }}>
						{stat.total} / {stat.running}
					</Text>
				</Group>
			</Group>

			<DroppableContainer
				id={cid(g.groupId)}
				disabled={isFiltering}
				minDropHeight={isCollapsed ? 10 : 0}
			>
				<Collapse in={!isCollapsed}>
					<SortableContext
						items={visibleIds.map((id) => iid(id))}
						strategy={verticalListSortingStrategy}
					>
						<Stack gap={0} mt="xs" align="stretch">
							{visibleIds.map((id) => (
								<SortableRow
									key={id}
									pid={id}
									name={getName(id)}
									running={runningSet.has(id)}
									selected={selectedSet.has(id)}
									active={activeSet.has(id)}
									onRightSelect={onRightSelect}
									LinkComp={LinkComp}
									disabled={isFiltering}
									dh={dh}
								/>
							))}
							{visibleIds.length === 0 && (
								<Text c="dimmed" size="xs" pl="xs" py={4}>
									（空）
								</Text>
							)}
						</Stack>
					</SortableContext>
				</Collapse>
			</DroppableContainer>
		</Card>
	)
})

// ---------- 主组件 ----------
export function PluginOrganizer({
	statuses,
	initialGroups,
	onGroupsChange,
	filterQuery = '',
	LinkComponent,
	activeId: propActiveId = null,
	activeIds,
	density = 'compact',
}: Props) {
	const theme = useMantineTheme()
	const dh = DENSITY[density]

	// 基础映射
	const runningSet = useMemo(() => {
		const s = new Set<string>()
		for (const [id, status] of Object.entries(statuses)) if (status.isRunning) s.add(id)
		return s
	}, [statuses])
	const getName = useCallback((id: string) => statuses[id]?.name ?? id, [statuses])

	const allIds = useMemo(() => Object.keys(statuses), [statuses])
	const { groups: saneGroups, ungrouped: saneUngrouped } = useMemo(
		() => sanitize(allIds, initialGroups),
		[allIds, initialGroups],
	)

	// 状态
	const [groups, setGroups] = useState<GroupConfig[]>(saneGroups)
	const [ungroupedOrder, setUngroupedOrder] = useState<string[]>(saneUngrouped)
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
	const lastSelectedRef = useRef<string | null>(null)
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>({}) // 组折叠状态

	// 导航态集合
	const activeSet = useMemo(() => {
		if (propActiveId) return new Set([propActiveId])
		if (activeIds?.length) return new Set(activeIds)
		return new Set<string>()
	}, [propActiveId, activeIds])

	// 回调 refs
	const onGroupsChangeRef = useRef(onGroupsChange)
	useEffect(() => {
		onGroupsChangeRef.current = onGroupsChange
	}, [onGroupsChange])
	const groupsRef = useRef(groups)
	useEffect(() => {
		groupsRef.current = groups
	}, [groups])
	const ungroupedRef = useRef(ungroupedOrder)
	useEffect(() => {
		ungroupedRef.current = ungroupedOrder
	}, [ungroupedOrder])

	// 过滤
	const q = filterQuery.trim().toLowerCase()
	const isFiltering = q.length > 0
	const match = useCallback(
		(id: string) => {
			if (!isFiltering) return true
			const st = statuses[id]
			const name = (st?.name || '').toLowerCase()
			return name.includes(q) || id.toLowerCase().includes(q)
		},
		[isFiltering, q, statuses],
	)

	// 可见数据
	const assignedSet = useMemo(() => {
		const s = new Set<string>()
		for (const g of groups) for (const id of g.pluginIds) s.add(id)
		return s
	}, [groups])

	const visibleUngrouped = useMemo(
		() => ungroupedOrder.filter((id) => !assignedSet.has(id)).filter(match),
		[ungroupedOrder, assignedSet, match],
	)
	const visibleGroups = useMemo(
		() => groups.map((g) => ({ ...g, pluginIds: g.pluginIds.filter(match) })),
		[groups, match],
	)

	// —— 选择：右键触发；Ctrl/Cmd 多选，Shift 区间 —— //
	const buildContainers = useCallback((gs: GroupConfig[], un: string[]) => {
		const containerToItems = new Map<string, string[]>()
		containerToItems.set(
			'ROOT_UNGROUPED',
			un.filter((id) => !gs.some((g) => g.pluginIds.includes(id))),
		)
		for (const g of gs) containerToItems.set(g.groupId, [...g.pluginIds])
		const itemToContainer = new Map<string, string>()
		for (const [k, v] of containerToItems) for (const id of v) itemToContainer.set(id, k)
		return { containerToItems, itemToContainer }
	}, [])

	const handleRightSelect = useCallback(
		(e: React.MouseEvent, id: string) => {
			startTransition(() => {
				if (e.shiftKey && lastSelectedRef.current) {
					const containers = buildContainers(groupsRef.current, ungroupedRef.current)
					const cidA = containers.itemToContainer.get(id)
					const cidB = containers.itemToContainer.get(lastSelectedRef.current)
					if (cidA && cidB && cidA === cidB) {
						const list = containers.containerToItems.get(cidA) ?? []
						const a = list.indexOf(id)
						const b = list.indexOf(lastSelectedRef.current)
						if (a >= 0 && b >= 0) {
							const [lo, hi] = a < b ? [a, b] : [b, a]
							setSelectedIds((sel) => unique([...sel, ...list.slice(lo, hi + 1)]))
							return
						}
					}
				}
				lastSelectedRef.current = id
				if (e.ctrlKey || e.metaKey) {
					setSelectedIds((sel) => (sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id]))
				} else {
					setSelectedIds([id])
				}
			})
		},
		[buildContainers],
	)

	// 外部数据变化同步
	useEffect(() => {
		setGroups(saneGroups)
		setUngroupedOrder((prev) => {
			const set = new Set(saneUngrouped)
			const kept = prev.filter((id) => set.has(id))
			const added = saneUngrouped.filter((id) => !kept.includes(id))
			return [...kept, ...added]
		})
	}, [saneGroups, saneUngrouped])

	// 剪裁幽灵选择
	useEffect(() => {
		setSelectedIds((sel) => sel.filter((id) => allIds.includes(id)))
	}, [allIds])

	// —— 右键菜单（根 / 组）——
	const [menu, setMenu] = useState<{
		open: boolean
		x: number
		y: number
		type: 'ROOT' | 'GROUP'
		gid?: string
	}>({ open: false, x: 0, y: 0, type: 'ROOT' })
	const closeMenu = useCallback(() => setMenu((m) => ({ ...m, open: false })), [])
	useEffect(() => {
		if (!menu.open) return
		const handle = () => closeMenu()
		document.addEventListener('mousedown', handle, { capture: true })
		return () => document.removeEventListener('mousedown', handle, { capture: true } as any)
	}, [menu.open, closeMenu])
	const openMenu = useCallback((e: React.MouseEvent, type: 'ROOT' | 'GROUP', gid?: string) => {
		e.preventDefault()
		e.stopPropagation()
		setMenu({ open: true, x: e.clientX, y: e.clientY, type, gid })
	}, [])

	const createGroup = useCallback(() => {
		const name = prompt('请输入新文件夹名称：')?.trim()
		if (!name) return
		const next: GroupConfig[] = [
			...groupsRef.current,
			{ groupId: genGroupId(), name, pluginIds: [] },
		]
		setGroups(next)
		onGroupsChangeRef.current?.(next)
		closeMenu()
	}, [closeMenu])

	const renameGroup = useCallback(() => {
		const gid0 = menu.gid
		if (!gid0) return
		const idx = groupsRef.current.findIndex((g) => g.groupId === gid0)
		if (idx < 0) return
		const name = prompt('重命名文件夹：', groupsRef.current[idx].name)?.trim()
		if (!name) return
		const next = groupsRef.current.map((g, i) => (i === idx ? { ...g, name } : g))
		setGroups(next)
		onGroupsChangeRef.current?.(next)
		closeMenu()
	}, [menu.gid, closeMenu])

	const deleteGroup = useCallback(() => {
		const gid0 = menu.gid
		if (!gid0) return
		const idx = groupsRef.current.findIndex((g) => g.groupId === gid0)
		if (idx < 0) return
		const victim = groupsRef.current[idx]
		const count = victim?.pluginIds.length ?? 0
		if (!confirm(`删除文件夹「${victim?.name}」？\n将把其中 ${count} 个插件移入“未分组”。`)) return
		const nextUngrouped = unique([...ungroupedRef.current, ...victim.pluginIds])
		const nextGroups = groupsRef.current.filter((_, i) => i !== idx)
		setGroups(nextGroups)
		setUngroupedOrder(nextUngrouped)
		setCollapsed((m) => {
			const copy = { ...m }
			delete copy[gid0]
			return copy
		})
		onGroupsChangeRef.current?.(nextGroups)
		closeMenu()
	}, [menu.gid, closeMenu])

	// —— 传感器 —— //
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)

	const [dragActiveId, setDragActiveId] = useState<UniqueIdentifier | null>(null)
	const groupIdsSortable = useMemo(() => groups.map((g) => gid(g.groupId)), [groups])
	const LinkComp = LinkComponent

	// —— 小工具：插入/重排 —— //
	const insertKeepOrder = (
		base: string[],
		moving: Set<string>,
		orderedMoving: string[],
		at: number,
	) => {
		const filtered = base.filter((x) => !moving.has(x))
		const idx = Math.max(0, Math.min(at, filtered.length))
		return [...filtered.slice(0, idx), ...orderedMoving, ...filtered.slice(idx)]
	}
	const computeTargetIndex = (
		full: string[],
		movingSet: Set<string>,
		overId?: string,
		opts?: { selfBehavior?: 'before' | 'after' },
	): number => {
		const filtered = full.filter((x) => !movingSet.has(x))
		if (!overId) return filtered.length

		// 当悬停在“自身（或选择块）”上时，基于期望行为决定插入点
		if (movingSet.has(overId)) {
			const behavior = opts?.selfBehavior ?? 'after'
			// 计算移动块的边界
			let first = Number.POSITIVE_INFINITY
			let last = -1
			for (let i = 0; i < full.length; i++) {
				if (movingSet.has(full[i])) {
					if (i < first) first = i
					if (i > last) last = i
				}
			}
			if (behavior === 'after') {
				// 找到移动块之后的第一个非移动项，插入到它之后（index + 1）
				const next = full.slice(last + 1).find((x) => !movingSet.has(x))
				return next ? Math.max(0, filtered.indexOf(next) + 1) : filtered.length
			}
			// 找到移动块之前的最后一个非移动项，插入到它之前
			const prev = [...full.slice(0, Math.max(0, first))].reverse().find((x) => !movingSet.has(x))
			return prev ? Math.max(0, filtered.indexOf(prev)) : 0
		}

		// 正常情况：插入到目标项之前
		return Math.max(0, filtered.indexOf(overId))
	}

	// —— Drag handlers —— //
	const handleDragStart = useCallback(
		({ active }: DragStartEvent) => {
			setDragActiveId(active.id)
			if (isIid(active.id)) {
				const pid = fromIid(String(active.id))
				if (!selectedSet.has(pid)) startTransition(() => setSelectedIds([pid]))
			}
			document.body.style.userSelect = 'none'
		},
		[selectedSet],
	)

	const handleDragEnd = useCallback(
		({ active, over, delta }: DragEndEvent) => {
			document.body.style.userSelect = ''
			const aId = active?.id as UniqueIdentifier
			const oId = over?.id as UniqueIdentifier | undefined
			setDragActiveId(null)
			if (!oId) return

			const containers = ((): {
				containerToItems: Map<string, string[]>
				itemToContainer: Map<string, string>
			} => {
				const containerToItems = new Map<string, string[]>()
				containerToItems.set(
					'ROOT_UNGROUPED',
					ungroupedRef.current.filter(
						(id) => !groupsRef.current.some((g) => g.pluginIds.includes(id)),
					),
				)
				for (const g of groupsRef.current) containerToItems.set(g.groupId, [...g.pluginIds])
				const itemToContainer = new Map<string, string>()
				for (const [k, v] of containerToItems) for (const id of v) itemToContainer.set(id, k)
				return { containerToItems, itemToContainer }
			})()

			// 组排序
			if (isGid(aId) && isGid(oId)) {
				const a = fromGid(String(aId))
				const b = fromGid(String(oId))
				const list = groupsRef.current.map((g) => g.groupId)
				const oldIndex = list.indexOf(a)
				const newIndex = list.indexOf(b)
				if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return
				const next = arrayMove(groupsRef.current, oldIndex, newIndex)
				setGroups(next)
				onGroupsChangeRef.current?.(next)
				return
			}

			// 条目移动/排序
			if (!isIid(aId)) return

			const moving =
				selectedIds.length > 1 && selectedIds.includes(fromIid(String(aId)))
					? selectedIds
					: [fromIid(String(aId))]
			const movingSet = new Set(moving)
			const orderedMoving = (
				containers.containerToItems.get(
					containers.itemToContainer.get(fromIid(String(aId))) || '',
				) || []
			).filter((x) => movingSet.has(x))

			const fromC = containers.itemToContainer.get(fromIid(String(aId)))
			const toC = isCid(oId)
				? fromCid(String(oId))
				: isIid(oId)
					? (containers.itemToContainer.get(fromIid(String(oId))) ?? 'ROOT_UNGROUPED')
					: undefined
			if (!fromC || !toC) return

			// 同容器：一次性重排
			if (fromC === toC) {
				const full = containers.containerToItems.get(fromC) ?? []
				const targetId = isIid(oId) ? fromIid(String(oId)) : undefined
				const selfBehavior: 'before' | 'after' | undefined =
					targetId && movingSet.has(targetId)
						? (delta?.y ?? 0) < 0
							? 'before'
							: 'after'
						: undefined
				const targetIndex = computeTargetIndex(full, movingSet, targetId, { selfBehavior })
				const nextList = insertKeepOrder(full, movingSet, orderedMoving, targetIndex)
				if (fromC === 'ROOT_UNGROUPED') {
					setUngroupedOrder(nextList)
				} else {
					setGroups((prev) =>
						prev.map((g) => (g.groupId === fromC ? { ...g, pluginIds: nextList } : g)),
					)
				}
				queueMicrotask(() => {
					const next = groupsRef.current
					assertNoDup(next, ungroupedRef.current)
					onGroupsChangeRef.current?.(next)
				})
				return
			}

			// 跨容器：移出 + 插入
			const fromFull = containers.containerToItems.get(fromC) ?? []
			const toFull = containers.containerToItems.get(toC) ?? []
			const targetId = isIid(oId) ? fromIid(String(oId)) : undefined
			const toIndex = computeTargetIndex(toFull, movingSet, targetId)

			if (fromC === 'ROOT_UNGROUPED') {
				setUngroupedOrder(fromFull.filter((x) => !movingSet.has(x)))
			} else {
				setGroups((prev) =>
					prev.map((g) =>
						g.groupId === fromC
							? { ...g, pluginIds: g.pluginIds.filter((x) => !movingSet.has(x)) }
							: g,
					),
				)
			}

			if (toC === 'ROOT_UNGROUPED') {
				setUngroupedOrder((prev) => insertKeepOrder(prev, movingSet, moving, toIndex))
			} else {
				setGroups((prev) =>
					prev.map((g) =>
						g.groupId === toC
							? { ...g, pluginIds: insertKeepOrder(g.pluginIds, movingSet, moving, toIndex) }
							: g,
					),
				)
			}

			queueMicrotask(() => {
				const next = groupsRef.current
				assertNoDup(next, ungroupedRef.current)
				onGroupsChangeRef.current?.(next)
			})
		},
		[selectedIds],
	)

	return (
		<Stack gap={0} align="stretch" onContextMenu={(e) => openMenu(e, 'ROOT')}>
			{/* 右键菜单：根 */}
			<Menu
				opened={menu.open && menu.type === 'ROOT'}
				onClose={closeMenu}
				withinPortal
				keepMounted
				zIndex={10000}
			>
				<Menu.Dropdown style={{ position: 'fixed', top: menu.y, left: menu.x, minWidth: 160 }}>
					<Menu.Item leftSection={<IconFolderPlus size={16} />} onClick={createGroup}>
						创建文件夹
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			{/* 右键菜单：组 */}
			<Menu
				opened={menu.open && menu.type === 'GROUP'}
				onClose={closeMenu}
				withinPortal
				keepMounted
				zIndex={10000}
			>
				<Menu.Dropdown style={{ position: 'fixed', top: menu.y, left: menu.x, minWidth: 200 }}>
					<Menu.Label>文件夹</Menu.Label>
					<Menu.Item
						leftSection={<IconPencil size={16} />}
						onClick={renameGroup}
						disabled={!menu.gid}
					>
						重命名
					</Menu.Item>
					<Menu.Item
						leftSection={<IconTrash size={16} />}
						onClick={deleteGroup}
						color="red"
						disabled={!menu.gid}
					>
						删除文件夹
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			<DndContext
				sensors={sensors}
				collisionDetection={closestCorners} // 更贴合“有内边距/边框”的纵向列表
				modifiers={[restrictToVerticalAxis]}
				measuring={{ droppable: { strategy: MeasuringStrategy.Always } }} // 容器变化（折叠/过滤）时，持续重测
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
			>
				{/* 未分组 */}
				<Card withBorder radius="md" p="sm">
					<Group justify="space-between" align="center" mb={4} wrap="nowrap">
						<Group gap="xs" align="center">
							<Text fw={600} size="sm">
								未分组
							</Text>
							<Text size="xs" c="dimmed">
								{visibleUngrouped.length} /{' '}
								{visibleUngrouped.filter((id) => runningSet.has(id)).length}
							</Text>
						</Group>
					</Group>

					<DroppableContainer
						id={cid('ROOT_UNGROUPED')}
						disabled={isFiltering}
						minDropHeight={visibleUngrouped.length ? 0 : 12}
					>
						<SortableContext
							items={visibleUngrouped.map((id) => iid(id))}
							strategy={verticalListSortingStrategy}
						>
							<Stack gap={0} align="stretch">
								{visibleUngrouped.map((id) => (
									<SortableRow
										key={id}
										pid={id}
										name={getName(id)}
										running={runningSet.has(id)}
										selected={selectedSet.has(id)}
										active={activeSet.has(id)}
										onRightSelect={handleRightSelect}
										LinkComp={LinkComp}
										disabled={isFiltering}
										dh={dh}
									/>
								))}
								{visibleUngrouped.length === 0 && (
									<Text c="dimmed" size="xs" pl="xs" py={4}>
										（空）
									</Text>
								)}
							</Stack>
						</SortableContext>
					</DroppableContainer>
				</Card>

				<Divider variant="dashed" />

				{/* 组列表（组可拖拽重排） */}
				<SortableContext items={groupIdsSortable} strategy={verticalListSortingStrategy}>
					<Stack gap={0} align="stretch">
						{visibleGroups.map((g) => {
							const vis = g.pluginIds
							const isCollapsed = !!collapsed[g.groupId]
							return (
								<GroupCard
									key={g.groupId}
									g={g}
									visibleIds={vis}
									runningSet={runningSet}
									selectedSet={selectedSet}
									activeSet={activeSet}
									onRightSelect={handleRightSelect}
									LinkComp={LinkComp}
									sortableId={gid(g.groupId)}
									onContextMenu={(e) => openMenu(e, 'GROUP', g.groupId)}
									isFiltering={isFiltering}
									isCollapsed={isCollapsed}
									toggleCollapse={() => setCollapsed((m) => ({ ...m, [g.groupId]: !m[g.groupId] }))}
									getName={getName}
									dh={dh}
								/>
							)
						})}
					</Stack>
				</SortableContext>

				{/* 小芯片 Overlay：不挡视线 */}
				<DragOverlay dropAnimation={null}>
					{dragActiveId ? (
						<div style={{ pointerEvents: 'none', marginTop: 6, marginLeft: 6, opacity: 0.9 }}>
							<Badge variant="filled" size="sm">
								+{Math.max(1, selectedIds.length)}
							</Badge>
						</div>
					) : null}
				</DragOverlay>
			</DndContext>
		</Stack>
	)
}
