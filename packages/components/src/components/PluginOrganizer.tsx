// src/components/PluginOrganizer.tsx
/**
 * PluginOrganizer
 * -----------------------------------------------------------------------------
 * 设计目标
 * 1) 布局：上（未分组）固定高度，下（我的分组）占满剩余空间，并且仅“我的分组”区域竖向滚动
 *    - 根容器使用 CSS Grid：grid-template-rows: 'auto 1fr'
 *    - 下半区使用 Mantine ScrollArea，保持唯一滚动源，避免页面级滚动抖动
 *
 * 2) 状态流转（本地优先）
 *    - 仅在首次挂载时读取 external initialGroups；之后完全本地化
 *    - 外部变更仅通过 onGroupsChange 单向“提交”出去；提交位置统一在微任务队列
 *    - 当插件全集（statuses 的 keys）变化时：清洗组内/未分组的无效 ID；新 ID 默认进入未分组尾部
 *
 * 3) 搜索（混合搜索）
 *    - 输入字符串在前端本地低延迟匹配
 *    - 命中规则：组名包含 q || 组内任意插件(名称/ID)包含 q
 *      命中组名时：不裁剪该组插件（展示完整），只命中插件时：裁剪为命中子集
 *    - 未分组区则直接按插件维度匹配
 *
 * 4) DnD 体验 & 性能
 *    - dnd-kit：限制垂直轴、closestCorners、droppable MeasuringStrategy.Always（折叠/过滤时稳定）
 *    - 允许在空容器/折叠容器投放（minDropHeight 占位）
 *    - 支持多选块移动（右键选择；Ctrl/Cmd 多选；Shift 区间）
 *    - 拖拽结束后只触发一次外部提交，并在微任务队列中进行
 *
 * 5) 可达性与可维护性
 *    - 为列表/项/容器添加 role/aria 标注；键盘传感器可排序
 *    - 关键子项 memo 化（GroupCard / SortableRow），传入 props 最小化
 *    - 折叠状态持久化 localStorage，仅存储为 true 的折叠组 ID
 *
 * 6) 可扩展性
 *    - 预留 className/style 便于放入任意父布局（父级给到 height:100% 即可）
 *    - 可选 LinkComponent 适配路由（Wouter/React-Router 等）
 *
 * 注意
 * - 若列表超大（上千条）且需要极致性能，可接入 @tanstack/react-virtual 实现行级虚拟化；
 *   与 dnd-kit 结合需额外的测量缓存与占位策略，这里暂不内置。
 * -----------------------------------------------------------------------------
 */

import {
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
	Button,
	Card,
	Collapse,
	Flex,
	Group,
	Menu,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
	useMantineTheme,
} from '@mantine/core'
import {
	IconChevronDown,
	IconChevronRight,
	IconDotsVertical,
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
	/** 上传中/锁定态：禁用拖拽和分组操作 */
	locked?: boolean
	/** 允许外部容器传样式以确保 100% 高度环境 */
	className?: string
	style?: React.CSSProperties
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

const COLLAPSE_STORAGE_KEY = 'pluxel:plugin-organizer:collapsed'
const readCollapsedState = (): Record<string, boolean> => {
	if (typeof window === 'undefined') return {}
	try {
		const raw = window.localStorage.getItem(COLLAPSE_STORAGE_KEY)
		if (!raw) return {}
		const parsed = JSON.parse(raw)
		if (Array.isArray(parsed)) {
			return parsed.reduce<Record<string, boolean>>((acc, id) => {
				if (typeof id === 'string') acc[id] = true
				return acc
			}, {})
		}
		if (parsed && typeof parsed === 'object') {
			const acc: Record<string, boolean> = {}
			for (const [key, value] of Object.entries(parsed)) {
				if (typeof value === 'boolean' && value) acc[key] = true
			}
			return acc
		}
	} catch (error) {
		console.warn('[PluginOrganizer] Failed to parse collapse state', error)
	}
	return {}
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
			role="group"
			aria-roledescription="droppable container"
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
	const getVariant = useCallback(
		(color: string, variant: 'light' | 'filled') => {
			if (theme.fn?.variant) return theme.fn.variant({ color, variant })
			const palette = theme.colors[color as keyof typeof theme.colors] ?? theme.colors.blue
			if (!palette) return { background: undefined, color: undefined, border: undefined }
			if (variant === 'filled') {
				return {
					background: palette[6],
					color: theme.white,
					border: palette[6],
				}
			}
			return {
				background: palette[0],
				color: palette[9],
				border: palette[1],
			}
		},
		[theme],
	)
	const rowRef = useRef<HTMLAnchorElement | HTMLSpanElement | null>(null)
	const activeVariant = getVariant('indigo', theme.colorScheme === 'dark' ? 'filled' : 'light')
	const selectedVariant = getVariant('blue', theme.colorScheme === 'dark' ? 'filled' : 'light')
	const rowBackground = active
		? activeVariant.background
		: selected
			? selectedVariant.background
			: undefined
	const rowColor = active ? activeVariant.color : selected ? selectedVariant.color : undefined
	const separatorColor =
		theme.colorScheme === 'dark' ? theme.colors.dark[4] : theme.colors.gray[2]

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: iid(pid),
		disabled,
		animateLayoutChanges: () => false,
	})

	const href = `/plugins/${encodeURIComponent(pid)}`

	return (
		<Box
			ref={setNodeRef}
			onDoubleClick={() => (rowRef.current as HTMLAnchorElement | null)?.click?.()}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
				onRightSelect(e, pid)
			}}
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition,
				opacity: isDragging ? 0.9 : 1,
				height: dh.rowH,
				padding: `${dh.py}px ${dh.px}px`,
				display: 'flex',
				alignItems: 'center',
				gap: 6,
				borderRadius: 6,
				cursor: disabled ? 'default' : 'pointer',
				userSelect: 'none',
				background: rowBackground,
				color: rowColor,
				borderBottom: `1px solid ${separatorColor}`,
				boxSizing: 'border-box',
			}}
			data-po-row="1"
			data-selected={selected || undefined}
			data-active={active || undefined}
			role="listitem"
			aria-roledescription="draggable plugin row"
		>
			{active && (
				<Box
					aria-hidden
					style={{
						width: 2,
						alignSelf: 'stretch',
						background: activeVariant.color ?? theme.colors.indigo[6],
						borderTopLeftRadius: 6,
						borderBottomLeftRadius: 6,
					}}
				/>
			)}

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

			<Box style={{ flex: 1, minWidth: 0 }}>
				{LinkComp ? (
					<LinkComp to={href}>
						<Tooltip label={name} withinPortal withArrow openDelay={200}>
							<Text
								ref={rowRef as any}
								size={dh.font}
								style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
								aria-current={active ? 'page' : undefined}
							>
								{name}
							</Text>
						</Tooltip>
					</LinkComp>
				) : (
					<Tooltip label={name} withinPortal withArrow openDelay={200}>
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
					</Tooltip>
				)}
			</Box>

			{typeof running === 'boolean' && (
				<Group gap={6} wrap="nowrap">
				<Box
					component="span"
					aria-hidden
					style={{
						width: 6,
						height: 6,
						borderRadius: 6,
						background: running
							? getVariant('green', 'filled').background
							: getVariant('gray', 'light').background,
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
	isFiltering: boolean
	isCollapsed: boolean
	toggleCollapse: () => void
	getName: (id: string) => string
	dh: { rowH: number; px: number; py: number; font: 'xs' | 'sm' }
	onRename: (gid: string) => void
	onDelete: (gid: string) => void
	locked: boolean
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
		isFiltering,
		isCollapsed,
		toggleCollapse,
		getName,
		dh,
		onRename,
		onDelete,
		locked,
	} = props

	const { attributes, listeners, setNodeRef, transform, transition } = useSortable({
		id: sortableId,
		disabled: isFiltering || locked,
		animateLayoutChanges: () => false,
	})

	const stat = {
		total: visibleIds.length,
		running: visibleIds.filter((id) => runningSet.has(id)).length,
	}
	const collapseLabel = isCollapsed ? '展开分组' : '折叠分组'

	return (
		<Card
			ref={setNodeRef}
			withBorder
			radius="md"
			p="xs"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition,
				minWidth: 0,
			}}
			role="group"
			aria-label={`分组 ${g.name || '未命名'}`}
		>
			<Flex align="center" gap="xs" justify="space-between" style={{ minWidth: 0 }}>
				<Group gap={6} align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
					<Box style={{ minWidth: 0, flex: 1 }}>
						<Tooltip label={g.name || '未命名分组'} withinPortal withArrow>
							<Text
								fw={600}
								size="sm"
								style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
							>
								{g.name || '未命名分组'}
							</Text>
						</Tooltip>
					</Box>
					<Text size="xs" c="dimmed" style={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
						{stat.running}/{stat.total}
					</Text>
				</Group>

				<Group gap={4} align="center" wrap="nowrap" style={{ flexShrink: 0 }}>
					<Tooltip label={collapseLabel} withinPortal openDelay={200} withArrow>
						<ActionIcon
							size="sm"
							variant="subtle"
							aria-label={collapseLabel}
							onClick={toggleCollapse}
							style={{ flexShrink: 0 }}
						>
							{isCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
						</ActionIcon>
					</Tooltip>

					<Menu withinPortal position="bottom-end">
						<Menu.Target>
							<ActionIcon
								size="sm"
								variant="subtle"
								aria-label="更多操作"
								style={{ flexShrink: 0 }}
							>
								<IconDotsVertical size={14} />
							</ActionIcon>
						</Menu.Target>
						<Menu.Dropdown>
							<Menu.Item
								leftSection={<IconPencil size={14} />}
								onClick={() => onRename(g.groupId)}
								disabled={locked}
							>
								重命名
							</Menu.Item>
							<Menu.Item
								leftSection={<IconTrash size={14} />}
								color="red"
								onClick={() => onDelete(g.groupId)}
								disabled={locked}
							>
								删除分组
							</Menu.Item>
						</Menu.Dropdown>
					</Menu>

					<Tooltip
						label={locked ? '云端同步中' : '拖拽分组'}
						withinPortal
						openDelay={200}
						withArrow
					>
						<ActionIcon
							size="sm"
							variant="subtle"
							aria-label="拖拽分组"
							data-drag-handle
							style={{
								width: 26,
								height: 26,
								touchAction: 'none',
								cursor: locked ? 'not-allowed' : 'grab',
								flexShrink: 0,
							}}
							{...listeners}
							{...attributes}
							disabled={locked}
						>
							<IconGripVertical size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Flex>

			<DroppableContainer
				id={cid(g.groupId)}
				disabled={isFiltering || locked}
				minDropHeight={isCollapsed ? 10 : dh.rowH}
			>
				<Collapse in={!isCollapsed}>
					<SortableContext
						items={visibleIds.map((id) => iid(id))}
						strategy={verticalListSortingStrategy}
					>
						<Stack gap={0} mt="xs" align="stretch" role="list" aria-label="插件列表">
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
									disabled={isFiltering || locked}
									dh={dh}
								/>
							))}
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
	locked = false,
	className,
	style,
}: Props) {
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

	// —— 本地优先：只在首次挂载吃初始值 —— //
	const [groups, setGroups] = useState<GroupConfig[]>(() => saneGroups)
	const [ungroupedOrder, setUngroupedOrder] = useState<string[]>(() => saneUngrouped)

	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
	const lastSelectedRef = useRef<string | null>(null)
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readCollapsedState())

	// 导航态集合
	const activeSet = useMemo(() => {
		if (propActiveId) return new Set([propActiveId])
		if (activeIds?.length) return new Set(activeIds)
		return new Set<string>()
	}, [propActiveId, activeIds])

	// Refs for stable, local-first updates
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

	// 过滤（混合：组名 or 插件 name/ID）
	const q = filterQuery.trim().toLowerCase()
	const isFiltering = q.length > 0
	const pluginMatch = useCallback(
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
		() => ungroupedOrder.filter((id) => !assignedSet.has(id)).filter(pluginMatch),
		[ungroupedOrder, assignedSet, pluginMatch],
	)

	// 混合搜索：组名命中 -> 展示完整组；否则裁剪到命中插件子集
	const visibleGroups = useMemo(() => {
		if (!isFiltering) return groups.map((g) => ({ ...g }))
		return groups.reduce<GroupConfig[]>((acc, group) => {
			const nameMatch = (group.name || '').toLowerCase().includes(q)
			const pluginIds = nameMatch ? [...group.pluginIds] : group.pluginIds.filter(pluginMatch)
			if (!nameMatch && pluginIds.length === 0) return acc
			acc.push({ ...group, pluginIds })
			return acc
		}, [])
	}, [groups, isFiltering, q, pluginMatch])

	// —— 容器映射（复用给 Shift 选择 & 拖放） —— //
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

	// —— 选择：右键触发；Ctrl/Cmd 多选，Shift 区间 —— //
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

	// —— 外界状态变化（新增/删除插件 id）下的本地对齐 —— //
	useEffect(() => {
		const allow = new Set(allIds)
		setGroups((prev) => {
			let changed = false
			const normalized = prev.map((group) => {
				const filtered = group.pluginIds.filter((id) => allow.has(id))
				const sameLength = filtered.length === group.pluginIds.length
				const sameContent = sameLength
					? filtered.every((id, idx) => id === group.pluginIds[idx])
					: false
				if (!sameLength || !sameContent) {
					changed = true
					return { ...group, pluginIds: filtered }
				}
				return group
			})
			const base = changed ? normalized : prev
			setUngroupedOrder((prevUngrouped) => {
				const cleaned = prevUngrouped.filter((id) => allow.has(id))
				const assigned = new Set<string>()
				for (const group of base) for (const id of group.pluginIds) assigned.add(id)
				const existing = new Set([...cleaned, ...assigned])
				const missing = allIds.filter((id) => !existing.has(id))
				const nextUngrouped = [...cleaned, ...missing]
				if (nextUngrouped.length === prevUngrouped.length) {
					let same = true
					for (let i = 0; i < nextUngrouped.length; i += 1) {
						if (nextUngrouped[i] !== prevUngrouped[i]) {
							same = false
							break
						}
					}
					if (same) return prevUngrouped
				}
				return nextUngrouped
			})
			return changed ? normalized : prev
		})
	}, [allIds])

	// 剪裁幽灵选择
	useEffect(() => {
		setSelectedIds((sel) => sel.filter((id) => allIds.includes(id)))
	}, [allIds])

	// 折叠状态清洗 + 持久化
	useEffect(() => {
		setCollapsed((prev) => {
			const allow = new Set(groups.map((g) => g.groupId))
			let changed = false
			const next: Record<string, boolean> = {}
			for (const key of Object.keys(prev)) {
				if (allow.has(key) && prev[key]) {
					next[key] = true
				} else if (!allow.has(key)) {
					changed = true
				}
			}
			return changed ? next : prev
		})
	}, [groups])

	useEffect(() => {
		if (typeof window === 'undefined') return
		try {
			const collapsedKeys = Object.keys(collapsed).filter((key) => collapsed[key])
			window.localStorage.setItem(COLLAPSE_STORAGE_KEY, JSON.stringify(collapsedKeys))
		} catch (error) {
			console.warn('[PluginOrganizer] Failed to persist collapse state', error)
		}
	}, [collapsed])

	// —— 分组操作（本地优先，提交外部只在变更后） —— //
	const createGroup = useCallback(() => {
		const name = prompt('请输入新文件夹名称：')?.trim()
		if (!name) return
		const next: GroupConfig[] = [
			...groupsRef.current,
			{ groupId: genGroupId(), name, pluginIds: [] },
		]
		setGroups(next)
		queueMicrotask(() => onGroupsChangeRef.current?.(next))
	}, [])

	const renameGroup = useCallback((gid0: string) => {
		const idx = groupsRef.current.findIndex((g) => g.groupId === gid0)
		if (idx < 0) return
		const name = prompt('重命名文件夹：', groupsRef.current[idx].name)?.trim()
		if (!name) return
		const next = groupsRef.current.map((g, i) => (i === idx ? { ...g, name } : g))
		setGroups(next)
		queueMicrotask(() => onGroupsChangeRef.current?.(next))
	}, [])

	const deleteGroup = useCallback((gid0: string) => {
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
		queueMicrotask(() => onGroupsChangeRef.current?.(nextGroups))
	}, [])

	const toggleGroupCollapse = useCallback((groupId: string) => {
		setCollapsed((prev) => {
			if (prev[groupId]) {
				const next = { ...prev }
				delete next[groupId]
				return next
			}
			return { ...prev, [groupId]: true }
		})
	}, [])

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

		if (movingSet.has(overId)) {
			const behavior = opts?.selfBehavior ?? 'after'
			let first = Number.POSITIVE_INFINITY
			let last = -1
			for (let i = 0; i < full.length; i++) {
				if (movingSet.has(full[i])) {
					if (i < first) first = i
					if (i > last) last = i
				}
			}
			if (behavior === 'after') {
				const next = full.slice(last + 1).find((x) => !movingSet.has(x))
				return next ? Math.max(0, filtered.indexOf(next) + 1) : filtered.length
			}
			const prev = [...full.slice(0, Math.max(0, first))].reverse().find((x) => !movingSet.has(x))
			return prev ? Math.max(0, filtered.indexOf(prev)) : 0
		}

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

			const containers = buildContainers(groupsRef.current, ungroupedRef.current)

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
				queueMicrotask(() => onGroupsChangeRef.current?.(next))
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
		[buildContainers, selectedIds],
	)

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCorners}
			modifiers={[restrictToVerticalAxis]}
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			{/* 根：Grid 强制 “上 auto + 下 1fr”，下区占满剩余并滚动 */}
			<Box
				className={className}
				style={{
					display: 'grid',
					gridTemplateRows: 'auto 1fr',
					minHeight: 0,
					height: '100%',
					...style,
				}}
			>
				{/* 未分组：固定在顶部，不参与主滚动区 */}
				<Card withBorder radius="md" p="xs" style={{ minWidth: 0 }}>
					<Group justify="space-between" align="center" mb={4} wrap="nowrap">
						<Group gap={6} align="center">
							<Text fw={600} size="sm">
								未分组
							</Text>
							<Text size="xs" c="dimmed">
								{visibleUngrouped.filter((id) => runningSet.has(id)).length}/
								{visibleUngrouped.length}
							</Text>
						</Group>
						<Button
							size="compact-xs"
							variant="light"
							leftSection={<IconFolderPlus size={16} />}
							onClick={createGroup}
							disabled={locked}
						>
							新建分组
						</Button>
					</Group>

					<DroppableContainer
						id={cid('ROOT_UNGROUPED')}
						disabled={isFiltering || locked}
						minDropHeight={visibleUngrouped.length ? 0 : dh.rowH}
					>
						<SortableContext
							items={visibleUngrouped.map((id) => iid(id))}
							strategy={verticalListSortingStrategy}
						>
							<Stack gap={0} align="stretch" role="list" aria-label="未分组插件">
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
										disabled={isFiltering || locked}
										dh={dh}
									/>
								))}
							</Stack>
						</SortableContext>
					</DroppableContainer>
				</Card>

				{/* 我的分组：唯一滚动区，永远占用剩余高度 */}
				<Stack gap="xs" style={{ minHeight: 0, minWidth: 0, overflow: 'hidden', paddingTop: 8 }}>
					<Group justify="space-between" align="center">
						<Group gap={6} align="center">
							<Text fw={600} size="sm">
								我的分组
							</Text>
							<Text size="xs" c="dimmed">
								{visibleGroups.length} 个
							</Text>
						</Group>
					</Group>

					<ScrollArea
						type="auto"
						offsetScrollbars
						scrollbarSize={6}
						style={{ flex: 1, minHeight: 0, maxHeight: '100%' }}
						viewportProps={{ style: { paddingRight: 4, paddingBottom: 4 } }}
					>
						<Box style={{ minWidth: 0 }}>
							<SortableContext items={groupIdsSortable} strategy={verticalListSortingStrategy}>
								<Stack gap="xs" align="stretch" py={4}>
									{visibleGroups.length === 0 ? (
										<Text c="dimmed" size="xs" pl="xs">
											暂无分组，可在上方创建。
										</Text>
									) : (
										visibleGroups.map((g) => {
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
													isFiltering={isFiltering}
													isCollapsed={isCollapsed}
													toggleCollapse={() => toggleGroupCollapse(g.groupId)}
													getName={getName}
													dh={dh}
													onRename={renameGroup}
													onDelete={deleteGroup}
													locked={locked}
												/>
											)
										})
									)}
								</Stack>
							</SortableContext>
						</Box>
					</ScrollArea>
				</Stack>
			</Box>

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
	)
}
