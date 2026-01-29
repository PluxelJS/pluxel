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
	useComputedColorScheme,
	rgba,
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
import type { GroupConfig, PluginStatuses } from './types'
import {
	COLLAPSE_STORAGE_KEY,
	arraysEqual,
	assertNoDup,
	genGroupId,
	readCollapsedState,
	sanitize,
	unique,
} from './utils'

export type { GroupConfig, PluginStatus, PluginStatuses } from './types'

type Density = 'comfortable' | 'compact' | 'ultra'
const DENSITY: Record<Density, { rowH: number; px: number; py: number; font: 'xs' | 'sm' }> = {
	comfortable: { rowH: 38, px: 10, py: 8, font: 'sm' },
	compact: { rowH: 30, px: 8, py: 4, font: 'xs' },
	ultra: { rowH: 22, px: 6, py: 1, font: 'xs' },
}
const UNGROUPED_SCROLL_MAX_HEIGHT = 'clamp(160px, 32vh, 360px)'

type SearchTokens = {
	plain: string[]
	pkg: string[]
	tag: string[]
	version: string[]
	id: string[]
}

function parseSearchTokens(input: string): SearchTokens {
	const tokens = input
		.trim()
		.split(/\s+/)
		.map((t) => t.trim())
		.filter(Boolean)
	const result: SearchTokens = { plain: [], pkg: [], tag: [], version: [], id: [] }
	for (const token of tokens) {
		if (token.startsWith('@') && token.length > 1) {
			result.pkg.push(token.slice(1).toLowerCase())
		} else if (token.startsWith('#') && token.length > 1) {
			result.tag.push(token.slice(1).toLowerCase())
		} else if (token.startsWith('v:') && token.length > 2) {
			result.version.push(token.slice(2).toLowerCase())
		} else if (token.startsWith('id:') && token.length > 3) {
			result.id.push(token.slice(3).toLowerCase())
		} else {
			result.plain.push(token.toLowerCase())
		}
	}
	return result
}

function deriveRootLabel(moduleId: string | null | undefined, statusName: string) {
	if (!moduleId) return '本地插件'
	const normalized = moduleId.replace(/\\/g, '/')
	const parts = normalized.split('/').filter(Boolean)
	if (parts.length === 0) return '本地插件'
	const last = parts[parts.length - 1] ?? ''
	if (/\.[a-z0-9]+$/i.test(last)) parts.pop()
	const skip = new Set(['src', 'lib', 'dist', 'build'])
	let candidate = parts[parts.length - 1] ?? ''
	while (candidate && skip.has(candidate) && parts.length > 1) {
		parts.pop()
		candidate = parts[parts.length - 1] ?? ''
	}
	const normalizedCandidate = candidate.toLowerCase()
	const normalizedName = statusName.toLowerCase()
	if (normalizedCandidate === normalizedName && parts.length > 1) {
		parts.pop()
		candidate = parts[parts.length - 1] ?? candidate
		while (candidate && skip.has(candidate) && parts.length > 1) {
			parts.pop()
			candidate = parts[parts.length - 1] ?? candidate
		}
	}
	return candidate || '本地插件'
}

export type StatusFilter = {
	running: boolean
	stopped: boolean
	disabled: boolean
}

type Props = {
	statuses: PluginStatuses
	initialGroups: GroupConfig[]
	onGroupsChange: (groups: GroupConfig[]) => void
	filterQuery?: string
	statusFilter?: StatusFilter
	LinkComponent?: React.ComponentType<{ to: string; children: React.ReactNode }>
	activeId?: string | null
	activeIds?: string[]
	selectedIds?: string[]
	onSelectedIdsChange?: (ids: string[]) => void
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

// ---------- Droppable（空容器也能投放） ----------
function DroppableContainer({
	id,
	children,
	disabled,
	minDropHeight = 0,
	style,
}: {
	id: UniqueIdentifier
	children: React.ReactNode
	disabled?: boolean
	minDropHeight?: number
	style?: React.CSSProperties
}) {
	const { setNodeRef, isOver } = useDroppable({ id, disabled })
	return (
		<Box
			ref={setNodeRef}
			data-droppable-id={String(id)}
			style={{
				outline: isOver ? '1px dashed var(--mantine-color-blue-6)' : undefined,
				minHeight: minDropHeight,
				...style,
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
	enabled,
	selected,
	active,
	onSelect,
	LinkComp,
	disabled,
	dh,
	meta,
}: {
	pid: string
	name: string
	running?: boolean
	enabled?: boolean
	selected: boolean
	active: boolean
	onSelect: (e: React.MouseEvent, pid: string, mode?: 'click' | 'context') => void
	LinkComp?: React.ComponentType<{ to: string; children: React.ReactNode }>
	disabled: boolean
	dh: { rowH: number; px: number; py: number; font: 'xs' | 'sm' }
	meta?: { tag?: string; version?: string }
}) {
	const theme = useMantineTheme()
	const scheme = useComputedColorScheme('light', { getInitialValueInEffect: true })
	const isDark = scheme === 'dark'
	const rowRef = useRef<HTMLAnchorElement | HTMLSpanElement | null>(null)
	const brand = theme.colors.brand ?? theme.colors.indigo
	const accent = theme.colors.blue
	const showStatusLabel = dh.rowH >= 30
	const rowGap = dh.rowH <= 26 ? 4 : 6
	const handleSize = dh.rowH <= 26 ? 16 : 20
	const handleIconSize = dh.rowH <= 26 ? 14 : 16

	// 优化后的配色方案：提升背景可见度，保持文字清晰
	const activeBg = active
		? isDark
			? rgba(brand[5], 0.28) // 提升背景可见度到 0.28
			: rgba(brand[1], 0.45)
		: undefined
	const selectedBg = selected
		? isDark
			? rgba(accent[5], 0.22) // 提升选中态可见度到 0.22
			: rgba(accent[1], 0.35)
		: undefined
	const rowBackground = active ? activeBg : selected ? selectedBg : undefined
	const baseColorValue = isDark ? theme.colors.gray[2] : theme.colors.gray[8]
	const rowColorValue =
		active || selected
			? isDark
				? theme.colors.gray[0] // 使用 gray[0] 确保文字清晰
				: theme.colors.gray[9]
			: baseColorValue
	const separatorColor = isDark ? rgba(theme.colors.dark[4], 0.3) : rgba(theme.colors.gray[2], 0.5)

	const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
		id: iid(pid),
		disabled,
		animateLayoutChanges: () => false,
	})

	const href = `/plugins/${encodeURIComponent(pid)}`

	const metaLabel = useMemo(() => {
		const tag = meta?.tag?.trim()
		const version = meta?.version?.trim()
		if (tag && version) return `${tag}@${version}`
		if (tag) return tag
		if (version) return version
		return ''
	}, [meta?.tag, meta?.version])
	return (
		<Box
			ref={setNodeRef}
			onDoubleClick={() => (rowRef.current as HTMLAnchorElement | null)?.click?.()}
			onClick={(e) => {
				if (disabled) return
				if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
				onSelect(e, pid, 'click')
			}}
			onContextMenu={(e) => {
				e.preventDefault()
				e.stopPropagation()
				if (disabled) return
				onSelect(e, pid, 'context')
			}}
			data-plugin-row="true"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition: transition ?? 'opacity 120ms ease-out, background 120ms ease-out',
				opacity: isDragging ? 0.9 : 1,
				height: dh.rowH,
				padding: `${dh.py}px ${dh.px}px`,
				display: 'flex',
				alignItems: 'center',
				gap: rowGap,
				borderRadius: 6,
				cursor: disabled ? 'default' : 'pointer',
				userSelect: 'none',
				background: rowBackground,
				color: rowColorValue,
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
						background: isDark ? rgba(brand[3], 0.8) : brand[5], // 深色模式用更柔和的 brand[3]，浅色用 brand[5]
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
					width: handleSize,
					height: handleSize,
					flex: `0 0 ${handleSize}px`,
					touchAction: 'none',
					cursor: isDragging ? 'grabbing' : 'grab',
				}}
				{...listeners}
				{...attributes}
			>
				<IconGripVertical size={handleIconSize} />
			</ActionIcon>

			<Box style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
				{LinkComp ? (
					<LinkComp
						to={href}
						style={{ textDecoration: 'none', display: 'block', color: rowColorValue, minWidth: 0 }}
						onClick={(e: any) => {
							if (disabled) return
							e.stopPropagation()
							if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
							onSelect(e, pid, 'click')
						}}
					>
						<Tooltip label={name} withinPortal withArrow openDelay={200}>
							<Text
								ref={rowRef as any}
								size={dh.font}
								style={{
									whiteSpace: 'nowrap',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									color: rowColorValue,
								}}
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
							style={{
								whiteSpace: 'nowrap',
								overflow: 'hidden',
								textOverflow: 'ellipsis',
								color: rowColorValue,
							}}
							aria-current={active ? 'page' : undefined}
							onClick={(e) => {
								if (disabled) return
								e.stopPropagation()
								if (e.shiftKey || e.metaKey || e.ctrlKey) e.preventDefault()
								onSelect(e, pid, 'click')
							}}
						>
							{name}
						</Anchor>
					</Tooltip>
				)}
				{metaLabel && (
					<Text
						size="xs"
						style={{
							fontSize: 10,
							opacity: 0.7,
							whiteSpace: 'nowrap',
							flexShrink: 0,
							maxWidth: 120,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							color: rowColorValue,
						}}
					>
						{metaLabel}
					</Text>
				)}
			</Box>

			{typeof running === 'boolean' && (
				<Group
					gap={showStatusLabel ? 6 : 4}
					wrap="nowrap"
					aria-label={running ? '运行' : enabled === false ? '禁用' : '停止'}
				>
					<Tooltip
						label={running ? '运行' : enabled === false ? '禁用' : '停止'}
						withinPortal
						withArrow
						disabled={showStatusLabel}
						openDelay={200}
					>
						<Box
							component="span"
							aria-hidden
							style={{
								width: 6,
								height: 6,
								borderRadius: 6,
								background: running
									? isDark
										? rgba(theme.colors.teal[4], 0.85) // 使用 teal 代替 green，更柔和
										: rgba(theme.colors.teal[6], 0.8)
									: isDark
										? rgba(theme.colors.gray[6], 0.5) // 降低停止状态的视觉权重
										: rgba(theme.colors.gray[5], 0.6),
							}}
						/>
					</Tooltip>
					{showStatusLabel && (
						<Text size="xs" style={{ color: rowColorValue }}>
							{running ? '运行' : enabled === false ? '禁用' : '停止'}
						</Text>
					)}
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
	enabledSet: Set<string>
	selectedSet: Set<string>
	activeSet: Set<string>
	onSelect: (e: React.MouseEvent, id: string, mode?: 'click' | 'context') => void
	LinkComp?: React.ComponentType<{ to: string; children: React.ReactNode }>
	sortableId: UniqueIdentifier
	isFiltering: boolean
	isCollapsed: boolean
	toggleCollapse: () => void
	getName: (id: string) => string
	getMeta: (id: string) => { tag?: string; version?: string }
	dh: { rowH: number; px: number; py: number; font: 'xs' | 'sm' }
	onRename: (gid: string) => void
	onDelete: (gid: string) => void
	locked: boolean
}) {
	const {
		g,
		visibleIds,
		runningSet,
		enabledSet,
		selectedSet,
		activeSet,
		onSelect,
		LinkComp,
		sortableId,
		isFiltering,
		isCollapsed,
		toggleCollapse,
		getName,
		getMeta,
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
		<Box
			ref={setNodeRef}
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition: transition ?? 'opacity 120ms ease-out',
				minWidth: 0,
				padding: 4,
				borderBottom: '1px solid var(--mantine-color-default-border)',
			}}
			role="group"
			aria-label={`分组 ${g.name || '未命名'}`}
		>
			<Flex align="center" gap={2} justify="space-between" style={{ minWidth: 0 }}>
				<Group gap={4} align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
					<Box style={{ minWidth: 0, flex: 1 }}>
						<Tooltip label={g.name || '未命名分组'} withinPortal withArrow>
							<Text
								fw={600}
								size="xs"
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

				<Group gap={2} align="center" wrap="nowrap" style={{ flexShrink: 0 }}>
					<Tooltip label={collapseLabel} withinPortal openDelay={200} withArrow>
						<ActionIcon
							size="xs"
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
								size="xs"
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
							size="xs"
							variant="subtle"
							aria-label="拖拽分组"
							data-drag-handle
							style={{
								width: 22,
								height: 22,
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
						<Stack gap={0} mt={4} align="stretch" role="list" aria-label="插件列表">
							{visibleIds.map((id) => (
								<SortableRow
									key={id}
									pid={id}
									name={getName(id)}
									running={runningSet.has(id)}
									enabled={enabledSet.has(id)}
									selected={selectedSet.has(id)}
									active={activeSet.has(id)}
									onSelect={onSelect}
									LinkComp={LinkComp}
									disabled={isFiltering || locked}
									meta={getMeta(id)}
									dh={dh}
								/>
							))}
						</Stack>
					</SortableContext>
				</Collapse>
			</DroppableContainer>
		</Box>
	)
})

// ---------- 主组件 ----------
export function PluginOrganizer({
	statuses,
	initialGroups,
	onGroupsChange,
	filterQuery = '',
	statusFilter,
	LinkComponent,
	activeId: propActiveId = null,
	activeIds,
	selectedIds: controlledSelectedIds,
	onSelectedIdsChange,
	density = 'compact',
	locked = false,
	className,
	style,
}: Props) {
	const dh = DENSITY[density]
	const effectiveStatusFilter = statusFilter ?? { running: true, stopped: true, disabled: true }
	const searchTokens = useMemo(() => parseSearchTokens(filterQuery), [filterQuery])
	const hasStatusFilter =
		!effectiveStatusFilter.running ||
		!effectiveStatusFilter.stopped ||
		!effectiveStatusFilter.disabled

	// 基础映射
	const runningSet = useMemo(() => {
		const s = new Set<string>()
		for (const [id, status] of Object.entries(statuses)) if (status.isRunning) s.add(id)
		return s
	}, [statuses])
	const enabledSet = useMemo(() => {
		const s = new Set<string>()
		for (const [id, status] of Object.entries(statuses)) if (status.isEnabled !== false) s.add(id)
		return s
	}, [statuses])
	const getName = useCallback((id: string) => statuses[id]?.name ?? id, [statuses])
	const getMeta = useCallback(
		(id: string) => ({ tag: statuses[id]?.tag, version: statuses[id]?.version }),
		[statuses],
	)

	const allIds = useMemo(() => Object.keys(statuses), [statuses])
	const { groups: saneGroups, ungrouped: saneUngrouped } = useMemo(
		() => sanitize(allIds, initialGroups),
		[allIds, initialGroups],
	)

	// —— 本地优先：只在首次挂载吃初始值 —— //
	const [groups, setGroups] = useState<GroupConfig[]>(() => saneGroups)
	const [ungroupedOrder, setUngroupedOrder] = useState<string[]>(() => saneUngrouped)

	const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>([])
	const selectedIds = controlledSelectedIds ?? internalSelectedIds
	const setSelectedIds = useCallback(
		(next: React.SetStateAction<string[]>) => {
			if (controlledSelectedIds === undefined) {
				setInternalSelectedIds((prev) => {
					const resolved =
						typeof next === 'function' ? (next as (p: string[]) => string[])(prev) : next
					if (arraysEqual(resolved, prev)) return prev
					onSelectedIdsChange?.(resolved)
					return resolved
				})
				return
			}
			const base = controlledSelectedIds
			const resolved = typeof next === 'function' ? (next as (p: string[]) => string[])(base) : next
			if (arraysEqual(resolved, base)) return
			onSelectedIdsChange?.(resolved)
		},
		[controlledSelectedIds, onSelectedIdsChange],
	)
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

	// 过滤（混合：组名 or 插件 name/ID + 语法）
	const isFiltering =
		searchTokens.plain.length > 0 ||
		searchTokens.pkg.length > 0 ||
		searchTokens.tag.length > 0 ||
		searchTokens.version.length > 0 ||
		searchTokens.id.length > 0 ||
		hasStatusFilter
	const pluginMatch = useCallback(
		(id: string) => {
			const st = statuses[id]
			const name = (st?.name || '').toLowerCase()
			const pkg = (st?.packageName || '').toLowerCase()
			const tag = (st?.tag || '').toLowerCase()
			const version = (st?.version || '').toLowerCase()
			const idValue = id.toLowerCase()

			const running = !!st?.isRunning
			const enabled = st?.isEnabled !== false
			const disabled = !enabled
			const stopped = enabled && !running
			const statusOk =
				(effectiveStatusFilter.running && running) ||
				(effectiveStatusFilter.stopped && stopped) ||
				(effectiveStatusFilter.disabled && disabled)

			if (!statusOk) return false

			const plainOk = searchTokens.plain.every((term) =>
				[name, pkg, tag, version, idValue].some((field) => field.includes(term)),
			)
			const pkgOk = searchTokens.pkg.every((term) => pkg.includes(term))
			const tagOk = searchTokens.tag.every((term) => tag.includes(term))
			const versionOk = searchTokens.version.every((term) => version.includes(term))
			const idOk = searchTokens.id.every((term) => idValue.includes(term))

			return plainOk && pkgOk && tagOk && versionOk && idOk
		},
		[effectiveStatusFilter, searchTokens, statuses],
	)

	const handleBackgroundClick = useCallback(
		(e: React.MouseEvent) => {
			// 点击空白区域时清空选择；如果命中行则不清空
			const target = e.target as HTMLElement | null
			if (target?.closest('[data-plugin-row]')) return
			setSelectedIds([])
			lastSelectedRef.current = null
		},
		[setSelectedIds],
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

	const hmrUngrouped = useMemo(
		() => visibleUngrouped.filter((id) => statuses[id]?.sourceKind === 'hmr'),
		[statuses, visibleUngrouped],
	)
	const packageUngrouped = useMemo(
		() => visibleUngrouped.filter((id) => statuses[id]?.sourceKind !== 'hmr'),
		[statuses, visibleUngrouped],
	)

	const hmrVirtualGroups = useMemo(() => {
		const map = new Map<string, { label: string; pluginIds: string[] }>()
		for (const id of hmrUngrouped) {
			const st = statuses[id]
			const label = deriveRootLabel(st?.moduleId ?? null, st?.name ?? id)
			const key = label || '本地插件'
			const group = map.get(key) ?? { label: key, pluginIds: [] }
			group.pluginIds.push(id)
			map.set(key, group)
		}
		return [...map.values()]
	}, [hmrUngrouped, statuses])

	const ungroupedDisplayOrder = useMemo(() => {
		const ordered: string[] = []
		for (const group of hmrVirtualGroups) ordered.push(...group.pluginIds)
		ordered.push(...packageUngrouped)
		return ordered
	}, [hmrVirtualGroups, packageUngrouped])

	// 混合搜索：组名命中 -> 展示完整组；否则裁剪到命中插件子集
	const visibleGroups = useMemo(() => {
		if (!isFiltering) return groups.map((g) => ({ ...g }))
		return groups.reduce<GroupConfig[]>((acc, group) => {
			const nameMatch =
				searchTokens.plain.length > 0 &&
				searchTokens.plain.every((term) => (group.name || '').toLowerCase().includes(term))
			const pluginIds = nameMatch ? [...group.pluginIds] : group.pluginIds.filter(pluginMatch)
			if (!nameMatch && pluginIds.length === 0) return acc
			acc.push({ ...group, pluginIds })
			return acc
		}, [])
	}, [groups, isFiltering, pluginMatch, searchTokens.plain])

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

	const selectionContainers = useMemo(
		() => buildContainers(visibleGroups, ungroupedDisplayOrder),
		[buildContainers, visibleGroups, ungroupedDisplayOrder],
	)

	// —— 选择：左键主选；Ctrl/Cmd 多选，Shift 区间；右键不打断已选 —— //
	const handleRowSelect = useCallback(
		(e: React.MouseEvent, id: string, mode: 'click' | 'context' = 'click') => {
			startTransition(() => {
				setSelectedIds((prev) => {
					const containers = selectionContainers
					const itemContainer = containers.itemToContainer.get(id)

					const toggle = e.ctrlKey || e.metaKey
					const range = e.shiftKey && lastSelectedRef.current
					let next = prev

					if (range && itemContainer) {
						const anchor = lastSelectedRef.current!
						const anchorContainer = containers.itemToContainer.get(anchor)
						if (anchorContainer && anchorContainer === itemContainer) {
							const list = containers.containerToItems.get(itemContainer) ?? []
							const a = list.indexOf(id)
							const b = list.indexOf(anchor)
							if (a >= 0 && b >= 0) {
								const [lo, hi] = a < b ? [a, b] : [b, a]
								const slice = list.slice(lo, hi + 1)
								next = toggle ? Array.from(new Set([...prev, ...slice])) : slice
							} else {
								next = [id]
							}
						} else {
							next = [id]
						}
					} else if (toggle) {
						next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
					} else if (mode === 'context') {
						next = prev.includes(id) ? prev : [id]
					} else {
						next = [id]
					}

					lastSelectedRef.current = next.includes(id) ? id : lastSelectedRef.current
					return next
				})
			})
		},
		[selectionContainers, setSelectedIds],
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
				if (!selectedSet.has(pid)) {
					startTransition(() => setSelectedIds([pid]))
					lastSelectedRef.current = pid
				}
			}
			document.body.style.userSelect = 'none'
		},
		[selectedSet, setSelectedIds],
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
				onClick={handleBackgroundClick}
			>
				{/* 未分组：固定在顶部，不参与主滚动区 */}
				<Card withBorder radius="xs" p={4} style={{ minWidth: 0 }}>
					<Group justify="space-between" align="center" mb={2} wrap="nowrap">
						<Group gap={4} align="center">
							<Text fw={600} size="xs">
								未分组
							</Text>
							<Text size="xs" c="dimmed">
								{visibleUngrouped.filter((id) => runningSet.has(id)).length}/
								{visibleUngrouped.length}
							</Text>
						</Group>
						<Tooltip label="新建分组" withinPortal withArrow openDelay={200}>
							<ActionIcon
								size="sm"
								variant="light"
								onClick={createGroup}
								disabled={locked}
								aria-label="新建分组"
							>
								<IconFolderPlus size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>

					<DroppableContainer
						id={cid('ROOT_UNGROUPED')}
						disabled={isFiltering || locked}
						minDropHeight={visibleUngrouped.length ? 0 : dh.rowH}
						style={{
							maxHeight: UNGROUPED_SCROLL_MAX_HEIGHT,
							overflowY: 'auto',
							overflowX: 'hidden',
							paddingRight: 4,
						}}
					>
						<SortableContext
							items={ungroupedDisplayOrder.map((id) => iid(id))}
							strategy={verticalListSortingStrategy}
						>
							<Stack gap={0} align="stretch" role="list" aria-label="未分组插件">
								{hmrVirtualGroups.map((group) => (
									<Box key={`hmr-group-${group.label}`} style={{ marginTop: 4 }}>
										<Text size="xs" c="dimmed" fw={600} style={{ padding: '2px 2px' }}>
											{group.label}
										</Text>
										{group.pluginIds.map((id) => (
											<SortableRow
												key={id}
												pid={id}
												name={getName(id)}
												running={runningSet.has(id)}
												enabled={enabledSet.has(id)}
												selected={selectedSet.has(id)}
												active={activeSet.has(id)}
												onSelect={handleRowSelect}
												LinkComp={LinkComp}
												disabled={isFiltering || locked}
												meta={getMeta(id)}
												dh={dh}
											/>
										))}
									</Box>
								))}
								{packageUngrouped.length > 0 && (
									<Box style={{ marginTop: hmrVirtualGroups.length ? 6 : 0 }}>
										{hmrVirtualGroups.length > 0 && (
											<Text size="xs" c="dimmed" fw={600} style={{ padding: '2px 2px' }}>
												包管理安装
											</Text>
										)}
										{packageUngrouped.map((id) => (
											<SortableRow
												key={id}
												pid={id}
												name={getName(id)}
												running={runningSet.has(id)}
												enabled={enabledSet.has(id)}
												selected={selectedSet.has(id)}
												active={activeSet.has(id)}
												onSelect={handleRowSelect}
												LinkComp={LinkComp}
												disabled={isFiltering || locked}
												meta={getMeta(id)}
												dh={dh}
											/>
										))}
									</Box>
								)}
							</Stack>
						</SortableContext>
					</DroppableContainer>
				</Card>

				{/* 我的分组：唯一滚动区，永远占用剩余高度 */}
				<Stack gap={2} style={{ minHeight: 0, minWidth: 0, overflow: 'hidden', paddingTop: 2 }}>
					<Group justify="space-between" align="center">
						<Group gap={4} align="center">
							<Text fw={600} size="xs">
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
						scrollbarSize={4}
						style={{ flex: 1, minHeight: 0, maxHeight: '100%' }}
						viewportProps={{ style: { paddingRight: 2, paddingBottom: 2 } }}
					>
						<Box style={{ minWidth: 0 }}>
							<SortableContext items={groupIdsSortable} strategy={verticalListSortingStrategy}>
								<Stack gap={2} align="stretch" py={2}>
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
													enabledSet={enabledSet}
													selectedSet={selectedSet}
													activeSet={activeSet}
													onSelect={handleRowSelect}
													LinkComp={LinkComp}
													sortableId={gid(g.groupId)}
													isFiltering={isFiltering}
													isCollapsed={isCollapsed}
													toggleCollapse={() => toggleGroupCollapse(g.groupId)}
													getName={getName}
													getMeta={getMeta}
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
