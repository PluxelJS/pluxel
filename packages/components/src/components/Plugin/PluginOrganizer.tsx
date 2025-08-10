// src/components/PluginOrganizer.tsx
import type React from 'react'
import {
	memo,
	useState,
	useCallback,
	useMemo,
	useEffect,
	useRef,
	startTransition,
} from 'react'
import {
	Card,
	Text,
	Group,
	Badge,
	Stack,
	Collapse,
	ActionIcon,
	Paper,
	useMantineTheme,
	Anchor,
	Divider,
	Menu,
	Box,
} from '@mantine/core'
import {
	IconFolderPlus,
	IconPencil,
	IconTrash,
	IconChevronDown,
	IconChevronRight,
	IconGripVertical,
} from '@tabler/icons-react'
import { showNotification } from '@mantine/notifications'

import {
	DndContext,
	DragOverlay,
	PointerSensor,
	KeyboardSensor,
	useSensor,
	useSensors,
	closestCenter,
	useDroppable,
	type UniqueIdentifier,
} from '@dnd-kit/core'
import {
	SortableContext,
	useSortable,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
	arrayMove,
} from '@dnd-kit/sortable'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'

// ---------- types & utils ----------
const genGroupId = () =>
	globalThis.crypto?.randomUUID?.() ??
	`g_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

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

type Props = {
	statuses: PluginStatus[]
	initialGroups: GroupConfig[]
	onGroupsChange: (groups: GroupConfig[]) => void
	filterQuery?: string
	LinkComponent?: React.ComponentType<{ to: string; children: React.ReactNode }>
	/** 当前导航所在插件（高亮“当前位置”）；建议仅使用此单值 */
	activeId?: string | null
	/** 兼容历史：若未传 activeId，则使用该集合 */
	activeIds?: string[]
}

// ---- id helpers（前缀化，避免冲突）----
const cid = (c: 'ROOT_UNGROUPED' | string) =>
	c === 'ROOT_UNGROUPED' ? 'c:ROOT' : (`c:${c}` as const)
const isCid = (id: UniqueIdentifier) =>
	typeof id === 'string' && id.startsWith('c:')
const fromCid = (id: string): 'ROOT_UNGROUPED' | string =>
	id === 'c:ROOT' ? 'ROOT_UNGROUPED' : id.slice(2)

const iid = (p: string) => `i:${p}`
const isIid = (id: UniqueIdentifier) =>
	typeof id === 'string' && id.startsWith('i:')
const fromIid = (id: string) => id.slice(2)

const gid = (g: string) => `g:${g}`
const isGid = (id: UniqueIdentifier) =>
	typeof id === 'string' && id.startsWith('g:')
const fromGid = (id: string) => id.slice(2)

function sanitize(allIds: string[], groups: GroupConfig[]) {
	const seen = new Set<string>()
	const allow = new Set(allIds)
	const nextGroups = groups.map((g) => ({
		groupId: g.groupId,
		name: g.name,
		pluginIds: g.pluginIds
			.filter((id) => allow.has(id))
			.filter((id) => {
				if (seen.has(id)) return false
				seen.add(id)
				return true
			}),
	}))
	const ungrouped = allIds.filter((id) => !seen.has(id))
	return { groups: nextGroups, ungrouped }
}
const unique = (arr: string[]) => Array.from(new Set(arr))
const assertNoDup = (groups: GroupConfig[], ungrouped: string[]) => {
	if (process.env.NODE_ENV !== 'production') {
		const seen = new Map<string, number>()
		for (const id of ungrouped) seen.set(id, (seen.get(id) ?? 0) + 1)
		for (const g of groups)
			for (const id of g.pluginIds) seen.set(id, (seen.get(id) ?? 0) + 1)
		const dup = [...seen].filter(([, n]) => n > 1).map(([id]) => id)
		if (dup.length)
			console.warn('[PluginOrganizer] Duplicate ids detected:', dup)
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
				outline: isOver ? '2px dashed var(--mantine-color-blue-6)' : undefined,
				minHeight: minDropHeight, // 折叠时也有一条可投放“细线”
			}}
		>
			{children}
		</Box>
	)
}

// ---------- 行（插件） ----------
const SortableRow = memo(function SortableRow({
	pid,
	name,
	running,
	selected,
	active,
	onRightSelect,
	LinkComp,
	disabled,
}: {
	pid: string
	name: string
	running?: boolean
	selected: boolean
	active: boolean
	onRightSelect: (e: React.MouseEvent, pid: string) => void
	LinkComp?: React.ComponentType<{ to: string; children: React.ReactNode }>
	disabled: boolean
}) {
	const theme = useMantineTheme()
	const rowRef = useRef<HTMLDivElement | null>(null)

	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({
		id: iid(pid),
		disabled,
		animateLayoutChanges: () => false,
	})

	const href = `/plugins/${pid}`

	return (
		<div
			ref={(el) => {
				setNodeRef(el)
				rowRef.current = el
			}}
			style={{
				width: '100%',
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0)`
					: undefined,
				transition,
				opacity: isDragging ? 0.9 : 1,
			}}
			onDoubleClick={(e) => {
				const inHandle = (e.target as HTMLElement).closest('[data-drag-handle]')
				if (inHandle) return
				const a = rowRef.current?.querySelector('a')
				if (a) (a as HTMLAnchorElement).click()
			}}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onRightSelect(e, pid)
			}}
		>
			<Paper
				withBorder
				radius="md"
				p="xs"
				data-po-row="1"
				data-selected={selected || undefined}
				data-active={active || undefined}
				style={{
					width: '100%',
					outline: selected ? `2px solid ${theme.colors.indigo[6]}` : undefined,
					outlineOffset: selected ? -2 : undefined,
					position: 'relative',
					background: active ? theme.colors.indigo[1] : undefined,
					cursor: disabled ? 'default' : 'pointer',
					userSelect: 'none',
				}}
			>
				{active && (
					<Box
						aria-hidden
						style={{
							position: 'absolute',
							left: 0,
							top: 0,
							bottom: 0,
							width: 3,
							background: theme.colors.indigo[6],
							borderTopLeftRadius: 6,
							borderBottomLeftRadius: 6,
						}}
					/>
				)}

				<Group justify="space-between" align="center" gap="sm" wrap="nowrap">
					<Box style={{ flex: 1, minWidth: 0 }}>
						{LinkComp ? (
							<LinkComp to={href}>
								<Text
									size="sm"
									style={{ display: 'block' }}
									aria-current={active ? 'page' : undefined}
								>
									{name}
								</Text>
							</LinkComp>
						) : (
							<Anchor
								size="sm"
								href={href}
								underline="never"
								style={{ display: 'block' }}
								aria-current={active ? 'page' : undefined}
							>
								{name}
							</Anchor>
						)}
					</Box>

					<Group gap="xs">
						{typeof running === 'boolean' && (
							<Badge variant="dot" color={running ? 'green' : 'gray'}>
								{running ? '运行中' : '已停止'}
							</Badge>
						)}

						<ActionIcon
							variant="light"
							title="拖拽排序"
							aria-label="拖拽排序"
							data-drag-handle
							style={{
								width: 30,
								height: 30,
								touchAction: 'none',
								cursor: isDragging ? 'grabbing' : 'grab',
							}}
							{...listeners}
							{...attributes}
						>
							<IconGripVertical size={18} />
						</ActionIcon>
					</Group>
				</Group>
			</Paper>
		</div>
	)
})

// ---------- 组卡片 ----------
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
	} = props

	const { attributes, listeners, setNodeRef, transform, transition } =
		useSortable({
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
			p="md"
			style={{
				transform: transform
					? `translate3d(${transform.x}px, ${transform.y}px, 0)`
					: undefined,
				transition,
			}}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onContextMenu(e)
			}}
		>
			<Group justify="space-between" align="center" wrap="nowrap">
				<Group gap="xs" align="center">
					<ActionIcon
						size="md"
						variant="subtle"
						title="拖拽分组"
						aria-label="拖拽分组"
						data-drag-handle
						style={{
							width: 32,
							height: 32,
							touchAction: 'none',
							cursor: 'grab',
						}}
						{...listeners}
						{...attributes}
					>
						<IconGripVertical size={18} />
					</ActionIcon>

					<ActionIcon
						size="sm"
						variant="subtle"
						onClick={toggleCollapse}
						aria-label="切换折叠"
					>
						{isCollapsed ? (
							<IconChevronRight size={16} />
						) : (
							<IconChevronDown size={16} />
						)}
					</ActionIcon>

					<Text fw={600}>{g.name}</Text>
					<Badge variant="light" size="sm">
						{stat.total}
					</Badge>
					<Badge variant="light" size="sm" color="green">
						{stat.running}
					</Badge>
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
						<Stack gap="xs" mt="sm" align="stretch">
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
								/>
							))}
							{visibleIds.length === 0 && (
								<Text c="dimmed" size="xs">
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
}: Props) {
	const theme = useMantineTheme()

	// 基础映射
	const statusMap = useMemo(
		() => new Map(statuses.map((s) => [s.id, s] as const)),
		[statuses],
	)
	const runningSet = useMemo(() => {
		const s = new Set<string>()
		for (const st of statuses) if (st.isRunning) s.add(st.id)
		return s
	}, [statuses])
	const getName = useCallback(
		(id: string) => statusMap.get(id)?.name ?? id,
		[statusMap],
	)

	const allIds = useMemo(() => statuses.map((s) => s.id), [statuses])
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

	// —— 导航态集合（单值优先，未给单值时兼容多值）——
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
			const st = statusMap.get(id)
			const name = (st?.name || '').toLowerCase()
			return name.includes(q) || id.toLowerCase().includes(q)
		},
		[isFiltering, q, statusMap],
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

	// —— 选择（右键触发；Ctrl/Cmd 多选，Shift 区间）——
	const buildContainers = useCallback((gs: GroupConfig[], un: string[]) => {
		const containerToItems = new Map<string, string[]>()
		containerToItems.set(
			'ROOT_UNGROUPED',
			un.filter((id) => !gs.some((g) => g.pluginIds.includes(id))),
		)
		for (const g of gs) containerToItems.set(g.groupId, [...g.pluginIds])
		const itemToContainer = new Map<string, string>()
		for (const [k, v] of containerToItems)
			for (const id of v) itemToContainer.set(id, k)
		return { containerToItems, itemToContainer }
	}, [])

	const handleRightSelect = useCallback(
		(e: React.MouseEvent, id: string) => {
			startTransition(() => {
				if (e.shiftKey && lastSelectedRef.current) {
					const containers = buildContainers(
						groupsRef.current,
						ungroupedRef.current,
					)
					const cidA = containers.itemToContainer.get(id)
					const cidB = containers.itemToContainer.get(lastSelectedRef.current)
					if (cidA && cidB && cidA === cidB) {
						const list = containers.containerToItems.get(cidA) ?? []
						const a = list.indexOf(id)
						const b = list.indexOf(lastSelectedRef.current)
						if (a >= 0 && b >= 0) {
							const [lo, hi] = a < b ? [a, b] : [b, a]
							setSelectedIds((sel) =>
								unique([...sel, ...list.slice(lo, hi + 1)]),
							)
							return
						}
					}
				}
				lastSelectedRef.current = id
				if (e.ctrlKey || e.metaKey) {
					setSelectedIds((sel) =>
						sel.includes(id) ? sel.filter((x) => x !== id) : [...sel, id],
					)
				} else {
					setSelectedIds([id])
				}
			})
		},
		[buildContainers],
	)

	// —— 外部数据变化：温和同步 ——
	useEffect(() => {
		setGroups(saneGroups)
		setUngroupedOrder((prev) => {
			const set = new Set(saneUngrouped)
			const kept = prev.filter((id) => set.has(id))
			const added = saneUngrouped.filter((id) => !kept.includes(id))
			return [...kept, ...added]
		})
	}, [saneGroups, saneUngrouped])

	// —— 外部数据变化：剪裁幽灵选择 ——
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
	const closeMenu = useCallback(
		() => setMenu((m) => ({ ...m, open: false })),
		[],
	)
	useEffect(() => {
		if (!menu.open) return
		const handle = () => closeMenu()
		document.addEventListener('mousedown', handle, { capture: true })
		return () =>
			document.removeEventListener('mousedown', handle, {
				capture: true,
			} as any)
	}, [menu.open, closeMenu])
	const openMenu = useCallback(
		(e: React.MouseEvent, type: 'ROOT' | 'GROUP', gid?: string) => {
			e.preventDefault()
			e.stopPropagation()
			setMenu({ open: true, x: e.clientX, y: e.clientY, type, gid })
		},
		[],
	)

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
		const next = groupsRef.current.map((g, i) =>
			i === idx ? { ...g, name } : g,
		)
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
		if (
			!confirm(
				`删除文件夹「${victim?.name}」？\n将把其中 ${count} 个插件移入“未分组”。`,
			)
		)
			return
		const nextUngrouped = unique([...ungroupedRef.current, ...victim.pluginIds])
		const nextGroups = groupsRef.current.filter((_, i) => i !== idx)
		setGroups(nextGroups)
		setUngroupedOrder(nextUngrouped)
		// 清理折叠状态中的残留键
		setCollapsed((m) => {
			const copy = { ...m }
			delete copy[gid0]
			return copy
		})
		onGroupsChangeRef.current?.(nextGroups)
		closeMenu()
	}, [menu.gid, closeMenu])

	// —— 传感器：提高阈值，避免误触 ——
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	)

	// 注意：这里是拖拽时的“活动项”，避免与 props.activeId 混淆
	const [dragActiveId, setDragActiveId] = useState<UniqueIdentifier | null>(
		null,
	)

	const groupIdsSortable = useMemo(
		() => groups.map((g) => gid(g.groupId)),
		[groups],
	)
	const LinkComp = LinkComponent

	// —— Drag handlers ——
	const handleDragStart = useCallback(
		({ active }: { active: { id: UniqueIdentifier } }) => {
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
		({ active, over }: { active: any; over: any }) => {
			document.body.style.userSelect = ''
			const aId = active?.id as UniqueIdentifier
			const oId = over?.id as UniqueIdentifier | undefined
			setDragActiveId(null)
			if (!oId) return

			const containers = buildContainers(
				groupsRef.current,
				ungroupedRef.current,
			)

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
				showNotification({ message: '已重新排序分组', color: 'gray' })
				return
			}

			// 条目移动/排序（支持多选）
			if (!isIid(aId)) return

			const moving =
				selectedIds.length > 1 && selectedIds.includes(fromIid(String(aId)))
					? selectedIds
					: [fromIid(String(aId))]
			const movingSet = new Set(moving)

			const fromC = containers.itemToContainer.get(fromIid(String(aId)))
			const toC = isCid(oId)
				? fromCid(String(oId))
				: isIid(oId)
					? (containers.itemToContainer.get(fromIid(String(oId))) ??
						'ROOT_UNGROUPED')
					: undefined
			if (!fromC || !toC) return

			// —— 同容器：一次性重排（修复“向下拖动回弹”）——
			if (fromC === toC) {
				const full = containers.containerToItems.get(fromC) ?? []
				const filtered = full.filter((x) => !movingSet.has(x))

				// 计算移动块在原列表中的首/末索引，用于判断方向
				const movingIdxs = moving
					.map((x) => full.indexOf(x))
					.sort((a, b) => a - b)
				const firstIdx = movingIdxs[0]
				const lastIdx = movingIdxs[movingIdxs.length - 1]

				let targetIndex: number
				if (isIid(oId)) {
					const overId = fromIid(String(oId))

					if (movingSet.has(overId)) {
						// 指针落在移动块上：取其后一位（原逻辑保留）
						const overPos = full.indexOf(overId)
						const after = full[overPos + 1]
						targetIndex = after ? filtered.indexOf(after) : filtered.length
					} else {
						// 指针落在非移动项上：根据方向决定插前/插后
						const overPosFull = full.indexOf(overId)
						const base = Math.max(0, filtered.indexOf(overId)) // “插前”的索引
						const movingDown = overPosFull > lastIdx // over 在移动块之后 => 向下
						targetIndex = movingDown ? base + 1 : base
					}
				} else {
					targetIndex = filtered.length
				}

				// 保持 moving 的相对顺序（按原列表顺序）
				const orderedMoving = full.filter((x) => movingSet.has(x))
				const nextList = [
					...filtered.slice(0, targetIndex),
					...orderedMoving,
					...filtered.slice(targetIndex),
				]

				if (fromC === 'ROOT_UNGROUPED') {
					setUngroupedOrder(nextList)
				} else {
					setGroups((prev) =>
						prev.map((g) =>
							g.groupId === fromC ? { ...g, pluginIds: nextList } : g,
						),
					)
				}

				queueMicrotask(() => {
					const next = groupsRef.current
					assertNoDup(next, ungroupedRef.current)
					onGroupsChangeRef.current?.(next)
				})
				showNotification({
					message: `已重新排序 ${moving.length} 项`,
					color: 'gray',
				})
				return
			}

			// —— 跨容器：一次性移出 + 插入 ——
			const fromFull = containers.containerToItems.get(fromC) ?? []
			const toFull = containers.containerToItems.get(toC) ?? []

			const fromNext = fromFull.filter((x) => !movingSet.has(x))

			let toTargetIndex: number
			if (isIid(oId)) {
				const overId = fromIid(String(oId))
				if (movingSet.has(overId)) {
					const overPos = toFull.indexOf(overId)
					const after = toFull[overPos + 1]
					const filteredTo = toFull.filter((x) => !movingSet.has(x))
					toTargetIndex = after ? filteredTo.indexOf(after) : filteredTo.length
				} else {
					const filteredTo = toFull.filter((x) => !movingSet.has(x))
					toTargetIndex = Math.max(0, filteredTo.indexOf(overId))
				}
			} else {
				toTargetIndex = toFull.filter((x) => !movingSet.has(x)).length
			}

			const insertInto = (list: string[], items: string[], index: number) => {
				const base = list.filter((x) => !movingSet.has(x))
				const orderedMoving = items
				const next = [
					...base.slice(0, index),
					...orderedMoving,
					...base.slice(index),
				]
				return unique(next)
			}

			if (fromC === 'ROOT_UNGROUPED' && toC === 'ROOT_UNGROUPED') {
				const filtered = fromFull.filter((x) => !movingSet.has(x))
				const nextUngrouped = insertInto(filtered, moving, toTargetIndex)
				setUngroupedOrder(nextUngrouped)
			} else if (fromC === 'ROOT_UNGROUPED') {
				setUngroupedOrder(fromNext)
				setGroups((prev) =>
					prev.map((g) => {
						if (g.groupId !== toC) return g
						const nextList = insertInto(g.pluginIds, moving, toTargetIndex)
						return { ...g, pluginIds: nextList }
					}),
				)
			} else if (toC === 'ROOT_UNGROUPED') {
				setGroups((prev) =>
					prev.map((g) =>
						g.groupId === fromC ? { ...g, pluginIds: fromNext } : g,
					),
				)
				setUngroupedOrder((prev) => insertInto(prev, moving, toTargetIndex))
			} else {
				setGroups((prev) =>
					prev.map((g) => {
						if (g.groupId === fromC) {
							return { ...g, pluginIds: fromNext }
						}
						if (g.groupId === toC) {
							const nextList = insertInto(g.pluginIds, moving, toTargetIndex)
							return { ...g, pluginIds: nextList }
						}
						return g
					}),
				)
			}

			queueMicrotask(() => {
				const next = groupsRef.current
				assertNoDup(next, ungroupedRef.current)
				onGroupsChangeRef.current?.(next)
			})
			showNotification({ message: `已移动 ${moving.length} 项`, color: 'blue' })
		},
		[selectedIds, buildContainers],
	)

	return (
		<Stack gap="sm" align="stretch" onContextMenu={(e) => openMenu(e, 'ROOT')}>
			{/* 右键菜单：根 */}
			<Menu
				opened={menu.open && menu.type === 'ROOT'}
				onClose={closeMenu}
				withinPortal
				keepMounted
				zIndex={10000}
			>
				<Menu.Dropdown
					style={{
						position: 'fixed',
						top: menu.y,
						left: menu.x,
						minWidth: 160,
					}}
				>
					<Menu.Item
						leftSection={<IconFolderPlus size={16} />}
						onClick={createGroup}
					>
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
				<Menu.Dropdown
					style={{
						position: 'fixed',
						top: menu.y,
						left: menu.x,
						minWidth: 200,
					}}
				>
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
				collisionDetection={closestCenter}
				modifiers={[restrictToVerticalAxis]}
				onDragStart={handleDragStart}
				onDragEnd={handleDragEnd}
			>
				{/* 未分组 */}
				<Card withBorder radius="md" p="md">
					<Group justify="space-between" align="center" mb="xs" wrap="nowrap">
						<Group gap="xs" align="center">
							<Text fw={600}>未分组</Text>
							<Badge variant="light" size="sm">
								{visibleUngrouped.length}
							</Badge>
							<Badge variant="light" size="sm" color="green">
								{visibleUngrouped.filter((id) => runningSet.has(id)).length}
							</Badge>
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
							<Stack gap="xs" align="stretch">
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
									/>
								))}
								{visibleUngrouped.length === 0 && (
									<Text c="dimmed" size="xs">
										（空）
									</Text>
								)}
							</Stack>
						</SortableContext>
					</DroppableContainer>
				</Card>

				<Divider variant="dashed" />

				{/* 组列表（组可拖拽重排） */}
				<SortableContext
					items={groupIdsSortable}
					strategy={verticalListSortingStrategy}
				>
					<Stack gap="md" align="stretch">
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
									toggleCollapse={() =>
										setCollapsed((m) => ({ ...m, [g.groupId]: !m[g.groupId] }))
									}
									getName={getName}
								/>
							)
						})}
					</Stack>
				</SortableContext>

				{/* 小芯片 Overlay：不挡视线 */}
				<DragOverlay dropAnimation={null}>
					{dragActiveId ? (
						<div
							style={{
								pointerEvents: 'none',
								marginTop: 8,
								marginLeft: 8,
								opacity: 0.9,
							}}
						>
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
