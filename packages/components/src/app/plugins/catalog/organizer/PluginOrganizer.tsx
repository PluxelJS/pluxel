// src/components/PluginOrganizer.tsx
/**
 * PluginOrganizer
 * -----------------------------------------------------------------------------
 * 设计目标
 * 1) 布局：上（未分组）与下（我的分组）弹性分配
 *    - 无分组时：未分组尽可能占满竖向空间；我的分组仅展示提示
 *    - 有分组时：未分组:我的分组 ≈ 1:2 分配空间，二者各自可滚动
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

import { closestCorners, DndContext, DragOverlay, MeasuringStrategy } from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ActionIcon, Badge, Box, Card, ScrollArea, Stack, Text, Tooltip } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { IconArrowsShuffle, IconFolderPlus, IconLayoutKanban } from '@tabler/icons-react'
import type React from 'react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
	DEFAULT_STATUS_FILTER,
	hasActiveSearchTokens,
	hasActiveStatusFilter,
	matchesGroupSearch,
	matchesPluginSearch,
} from '../filterModel'
import { parseSearchTokens } from '../searchTokens'
import { DroppableContainer } from './components/DroppableContainer'
import { FlatPluginList } from './components/FlatPluginList'
import { GroupEditorModal } from './components/GroupEditorModal'
import { GroupPlacementModal } from './components/GroupPlacementModal'
import { GroupCard } from './components/GroupCard'
import { SortableRow } from './components/SortableRow'
import { cid, gid, iid } from './controllerModel'
import { DENSITY, FILTERED_FLAT_VIRTUALIZE_THRESHOLD, type Density } from './constants'
import type { GroupConfig, PluginStatuses } from './types'
import {
	arraysEqual,
	COLLAPSE_STORAGE_KEY,
	deriveRootLabel,
	genGroupId,
	readCollapsedState,
	sanitize,
	unique,
} from './organizerModel'
import { movePluginIdsToTarget, sortPluginIdsByOrder } from './groupOperations'
import { usePluginOrganizerDnd } from './usePluginOrganizerDnd'
import { usePluginSelectionController } from './usePluginSelectionController'
import type { WorkbenchNavigationRequest } from '../../../workbench/context'

export type { GroupConfig, PluginStatus, PluginStatuses } from './types'

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
	LinkComponent?: React.ComponentType<
		{
			to: string
			children: React.ReactNode
			workbenchMode?: WorkbenchNavigationRequest
		} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>
	>
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

type GroupEditorState =
	| { mode: 'create'; initialName: string; pluginIds?: string[] }
	| { mode: 'rename'; groupId: string; initialName: string }
	| null

const groupsEqual = (a: GroupConfig[], b: GroupConfig[]) => {
	if (a === b) return true
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i += 1) {
		const ga = a[i]
		const gb = b[i]
		if (!gb) return false
		if (ga.groupId !== gb.groupId || ga.name !== gb.name) return false
		if (!arraysEqual(ga.pluginIds, gb.pluginIds)) return false
	}
	return true
}

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
	const effectiveStatusFilter = statusFilter ?? DEFAULT_STATUS_FILTER
	const searchTokens = useMemo(() => parseSearchTokens(filterQuery), [filterQuery])
	const hasStatusFilter = hasActiveStatusFilter(effectiveStatusFilter)

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
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readCollapsedState())
	const [groupEditor, setGroupEditor] = useState<GroupEditorState>(null)
	const [placementModalOpen, setPlacementModalOpen] = useState(false)

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

	const lastInitialGroupsRef = useRef<GroupConfig[]>(saneGroups)
	useEffect(() => {
		const lastInitial = lastInitialGroupsRef.current
		if (groupsEqual(lastInitial, saneGroups)) return

		const localGroups = groupsRef.current
		const localMatchesLast = groupsEqual(localGroups, lastInitial)
		const localMatchesNext = groupsEqual(localGroups, saneGroups)

		if (localMatchesLast && !localMatchesNext) {
			setGroups(saneGroups)
			setUngroupedOrder((prevUngrouped) => {
				const allow = new Set(allIds)
				const assigned = new Set<string>()
				for (const group of saneGroups) for (const id of group.pluginIds) assigned.add(id)
				const cleaned = prevUngrouped.filter((id) => allow.has(id) && !assigned.has(id))
				const existing = new Set(cleaned)
				const missing = allIds.filter((id) => !assigned.has(id) && !existing.has(id))
				return [...cleaned, ...missing]
			})
		}

		lastInitialGroupsRef.current = saneGroups
	}, [allIds, saneGroups])

	// 过滤（混合：组名 or 插件 name/ID + 语法）
	const isFiltering = hasActiveSearchTokens(searchTokens) || hasStatusFilter
	const pluginMatch = useCallback(
		(id: string) => matchesPluginSearch(id, statuses[id], searchTokens, effectiveStatusFilter),
		[effectiveStatusFilter, searchTokens, statuses],
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
	const visibleUngroupedRunning = useMemo(() => {
		let count = 0
		for (const id of visibleUngrouped) if (runningSet.has(id)) count += 1
		return count
	}, [runningSet, visibleUngrouped])

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
		if (!isFiltering) return groups
		return groups.reduce<GroupConfig[]>((acc, group) => {
			const nameMatch = matchesGroupSearch(group.name || '', searchTokens)
			const pluginIds = nameMatch ? [...group.pluginIds] : group.pluginIds.filter(pluginMatch)
			if (!nameMatch && pluginIds.length === 0) return acc
			acc.push({ ...group, pluginIds })
			return acc
		}, [])
	}, [groups, isFiltering, pluginMatch, searchTokens])
	const flatVisibleIds = useMemo(() => {
		if (!isFiltering) return ungroupedDisplayOrder
		const flattened = [...ungroupedDisplayOrder]
		for (const group of visibleGroups) flattened.push(...group.pluginIds)
		return flattened
	}, [isFiltering, ungroupedDisplayOrder, visibleGroups])
	const flatVisibleRunning = useMemo(() => {
		let count = 0
		for (const id of flatVisibleIds) if (runningSet.has(id)) count += 1
		return count
	}, [flatVisibleIds, runningSet])
	const showFlatResults = isFiltering
	const shouldVirtualizeFlatResults =
		showFlatResults && flatVisibleIds.length > FILTERED_FLAT_VIRTUALIZE_THRESHOLD

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

	const emitGroupsChange = useCallback((nextGroups: GroupConfig[]) => {
		queueMicrotask(() => onGroupsChangeRef.current(nextGroups))
	}, [])

	const openCreateGroupModal = useCallback((pluginIds?: string[]) => {
		setGroupEditor({ mode: 'create', initialName: '', pluginIds })
	}, [])

	const renameGroup = useCallback((groupId: string) => {
		const target = groupsRef.current.find((group) => group.groupId === groupId)
		if (!target) return
		setGroupEditor({ mode: 'rename', groupId, initialName: target.name })
	}, [])

	const handleGroupEditorSubmit = useCallback(
		(name: string) => {
			if (groupEditor?.mode === 'rename') {
				const nextGroups = groupsRef.current.map((group) =>
					group.groupId === groupEditor.groupId ? { ...group, name } : group,
				)
				setGroups(nextGroups)
				emitGroupsChange(nextGroups)
				setGroupEditor(null)
				return
			}

			const orderedPluginIds = groupEditor?.pluginIds?.length
				? sortPluginIdsByOrder(groupEditor.pluginIds, groupsRef.current, ungroupedRef.current)
				: []
			const normalized = orderedPluginIds.length > 0
				? movePluginIdsToTarget({
						groups: groupsRef.current,
						ungroupedOrder: ungroupedRef.current,
						pluginIds: orderedPluginIds,
						targetGroupId: 'ROOT_UNGROUPED',
					})
				: { groups: groupsRef.current, ungroupedOrder: ungroupedRef.current }
			const nextGroups: GroupConfig[] = [
				...normalized.groups,
				{ groupId: genGroupId(), name, pluginIds: orderedPluginIds },
			]
			setGroups(nextGroups)
			if (orderedPluginIds.length > 0) {
				setUngroupedOrder(normalized.ungroupedOrder)
			}
			emitGroupsChange(nextGroups)
			setGroupEditor(null)
		},
		[emitGroupsChange, groupEditor],
	)

	const deleteGroup = useCallback(
		(groupId: string) => {
			const target = groupsRef.current.find((group) => group.groupId === groupId)
			if (!target) return
			openConfirmModal({
				title: '删除分组',
				centered: true,
				labels: { confirm: '删除', cancel: '取消' },
				confirmProps: { color: 'red' },
				children: (
					<Text size="sm" c="dimmed">
						删除“{target.name || '未命名分组'}”后，组内 {target.pluginIds.length}{' '}
						个插件会回到未分组区。
					</Text>
				),
				onConfirm: () => {
					const nextGroups = groupsRef.current.filter((group) => group.groupId !== groupId)
					const nextUngrouped = unique([...ungroupedRef.current, ...target.pluginIds])
					setGroups(nextGroups)
					setUngroupedOrder(nextUngrouped)
					setCollapsed((current) => {
						const next = { ...current }
						delete next[groupId]
						return next
					})
					emitGroupsChange(nextGroups)
				},
			})
		},
		[emitGroupsChange],
	)

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

	const {
		activeSet,
		containerRef,
		focusedId,
		handleBackgroundClick,
		handleKeyDown,
		handleRowSelect,
		selectOnly,
		selectedIds,
		selectedSet,
	} = usePluginSelectionController({
		activeId: propActiveId,
		activeIds,
		allIds,
		controlledSelectedIds,
		onSelectedIdsChange,
		visibleGroups: showFlatResults ? [] : visibleGroups,
		ungroupedDisplayOrder: showFlatResults ? flatVisibleIds : ungroupedDisplayOrder,
		onCreateGroup: () => openCreateGroupModal(selectedIds.length > 0 ? selectedIds : undefined),
		onMoveSelection: () => setPlacementModalOpen(true),
		onMoveToUngrouped: () => moveSelectedPlugins('ROOT_UNGROUPED'),
		locked,
	})

	const selectedCount = selectedIds.length
	const groupPlacementOptions = useMemo(
		() => [
			{ value: 'ROOT_UNGROUPED', label: '未分组' },
			...groups.map((group) => ({
				value: group.groupId,
				label: group.name || '未命名分组',
			})),
		],
		[groups],
	)

	const moveSelectedPlugins = useCallback(
		(targetGroupId: string) => {
			if (selectedIds.length === 0) return
			const orderedPluginIds = sortPluginIdsByOrder(
				selectedIds,
				groupsRef.current,
				ungroupedRef.current,
			)
			const nextState = movePluginIdsToTarget({
				groups: groupsRef.current,
				ungroupedOrder: ungroupedRef.current,
				pluginIds: orderedPluginIds,
				targetGroupId: targetGroupId === 'ROOT_UNGROUPED' ? 'ROOT_UNGROUPED' : targetGroupId,
			})
			setGroups(nextState.groups)
			setUngroupedOrder(nextState.ungroupedOrder)
			emitGroupsChange(nextState.groups)
			setPlacementModalOpen(false)
		},
		[emitGroupsChange, selectedIds],
	)

	const { dragActiveId, groupIdsSortable, handleDragEnd, handleDragStart, sensors } =
		usePluginOrganizerDnd({
			groups,
			groupsRef,
			ungroupedRef,
			selectedIds,
			selectedSet,
			selectOnly,
			setGroups,
			setUngroupedOrder,
			onGroupsChangeRef,
		})

	const LinkComp = LinkComponent

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCorners}
			modifiers={[restrictToVerticalAxis]}
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			{/* 根：Grid 分配上下区高度；无分组时让未分组占满 */}
			<Box
				ref={containerRef}
				className={className}
				tabIndex={0}
				style={{
					display: 'grid',
					gridTemplateRows:
						groups.length > 0 && !showFlatResults
							? 'minmax(0, 1fr) minmax(0, 2fr)'
							: 'minmax(0, 1fr) auto',
					gap: 4,
					minHeight: 0,
					height: '100%',
					...style,
				}}
				onClick={handleBackgroundClick}
				onKeyDown={handleKeyDown}
				aria-label="插件列表与分组"
			>
				{/* 未分组：占用上半区；内部滚动 */}
				<Card
					className="plx-theme-panel plx-pluginCatalog__sectionCard"
					withBorder
					shadow="none"
					radius="md"
					p={4}
					style={{
						minWidth: 0,
						minHeight: 0,
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
					}}
				>
					<div className="plx-pluginCatalog__sectionHeader">
						<div className="plx-pluginCatalog__sectionHeading">
							<Text className="plx-pluginCatalog__sectionTitle">
								{showFlatResults ? '平铺结果' : '未分组'}
							</Text>
							<Text className="plx-pluginCatalog__sectionMetric">
								{showFlatResults
									? `${flatVisibleRunning}/${flatVisibleIds.length}`
									: `${visibleUngroupedRunning}/${visibleUngrouped.length}`}
							</Text>
						</div>
						<Box className="plx-pluginCatalog__sectionActions">
							{selectedCount > 0 ? (
								<>
									<Badge size="xs" variant="light" color="gray">
										已选 {selectedCount}
									</Badge>
									<Tooltip
										label="把当前所选插件建立成新分组"
										withinPortal
										withArrow
										openDelay={200}
									>
										<ActionIcon
											size="sm"
											variant="light"
											onClick={() => openCreateGroupModal(selectedIds)}
											disabled={locked}
											aria-label="从所选创建分组"
										>
											<IconLayoutKanban size={14} />
										</ActionIcon>
									</Tooltip>
									<Tooltip label="移动到其他分组" withinPortal withArrow openDelay={200}>
										<ActionIcon
											size="sm"
											variant="light"
											onClick={() => setPlacementModalOpen(true)}
											disabled={locked}
											aria-label="移动到分组"
										>
											<IconArrowsShuffle size={14} />
										</ActionIcon>
									</Tooltip>
									<Tooltip label="移回未分组" withinPortal withArrow openDelay={200}>
										<ActionIcon
											size="sm"
											variant="light"
											onClick={() => moveSelectedPlugins('ROOT_UNGROUPED')}
											disabled={locked}
											aria-label="移回未分组"
										>
											<IconFolderPlus size={14} />
										</ActionIcon>
									</Tooltip>
								</>
							) : null}
							<Tooltip label="新建分组" withinPortal withArrow openDelay={200}>
								<ActionIcon
									size="sm"
									variant="light"
									onClick={() => openCreateGroupModal()}
									disabled={locked}
									aria-label="新建分组"
								>
									<IconFolderPlus size={14} />
								</ActionIcon>
							</Tooltip>
						</Box>
					</div>
					<Text className="plx-pluginCatalog__sectionNote">
						{showFlatResults
							? '当前按筛选结果平铺显示，清空筛选后恢复分组编辑。'
							: 'G 创建或收拢为分组，M 移动到分组，U 移回未分组。'}
					</Text>

					{showFlatResults ? (
						<FlatPluginList
							ids={flatVisibleIds}
							virtualize={shouldVirtualizeFlatResults}
							runningSet={runningSet}
							enabledSet={enabledSet}
							selectedSet={selectedSet}
							activeSet={activeSet}
							focusedId={focusedId}
							onSelect={handleRowSelect}
							LinkComp={LinkComp}
							getName={getName}
							getMeta={getMeta}
							dh={dh}
							emptyLabel={isFiltering ? '没有匹配的插件。' : '暂无可显示的插件。'}
							listLabel={isFiltering ? '筛选结果插件' : '平铺插件'}
						/>
					) : (
						<DroppableContainer
							id={cid('ROOT_UNGROUPED')}
							disabled={isFiltering || locked}
							minDropHeight={visibleUngrouped.length > 0 ? 0 : dh.rowH}
							style={{
								flex: 1,
								minHeight: 0,
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
										<Box key={`hmr-group-${group.label}`} className="plx-pluginCatalog__subgroup">
											<div className="plx-pluginCatalog__subgroupHeader">
												<Text className="plx-pluginCatalog__subgroupLabel">{group.label}</Text>
												<Text className="plx-pluginCatalog__subgroupCount">
													{group.pluginIds.length} 个
												</Text>
											</div>
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
													dragDisabled={isFiltering || locked}
													focused={focusedId === id}
													meta={getMeta(id)}
													dh={dh}
													sortableId={iid(id)}
												/>
											))}
										</Box>
									))}
									{packageUngrouped.length > 0 && (
										<Box className="plx-pluginCatalog__subgroup">
											<div className="plx-pluginCatalog__subgroupHeader">
												<Text className="plx-pluginCatalog__subgroupLabel">
													{hmrVirtualGroups.length > 0 ? '包管理安装' : '未分组插件'}
												</Text>
												<Text className="plx-pluginCatalog__subgroupCount">
													{packageUngrouped.length} 个
												</Text>
											</div>
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
													dragDisabled={isFiltering || locked}
													focused={focusedId === id}
													meta={getMeta(id)}
													dh={dh}
													sortableId={iid(id)}
												/>
											))}
										</Box>
									)}
								</Stack>
							</SortableContext>
						</DroppableContainer>
					)}
				</Card>

				{/* 我的分组：有分组时占下半区并可滚动；无分组时收缩为提示行 */}
				{groups.length > 0 && !showFlatResults ? (
					<Card
						className="plx-theme-panel plx-pluginCatalog__sectionCard"
						withBorder
						shadow="none"
						radius="md"
						p={4}
						style={{
							minHeight: 0,
							minWidth: 0,
							overflow: 'hidden',
							display: 'flex',
							flexDirection: 'column',
						}}
					>
						<Stack gap={2} style={{ minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
							<div className="plx-pluginCatalog__sectionHeader">
								<div className="plx-pluginCatalog__sectionHeading">
									<Text className="plx-pluginCatalog__sectionTitle">我的分组</Text>
									<Text className="plx-pluginCatalog__sectionMetric">
										{visibleGroups.length} 个
									</Text>
								</div>
								<Text className="plx-pluginCatalog__sectionNote">Shift + 方向键可连续选择</Text>
							</div>

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
															focusedId={focusedId}
															LinkComp={LinkComp}
															sortableId={gid(g.groupId)}
															droppableId={cid(g.groupId)}
															isFiltering={isFiltering}
															isCollapsed={isCollapsed}
															toggleCollapse={() => toggleGroupCollapse(g.groupId)}
															getName={getName}
															getMeta={getMeta}
															getItemSortableId={(id) => iid(id)}
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
					</Card>
				) : (
					<Card
						className="plx-theme-panel plx-pluginCatalog__sectionCard"
						withBorder
						shadow="none"
						radius="md"
						p={4}
						style={{
							minWidth: 0,
						}}
					>
						<div className="plx-pluginCatalog__sectionHeader">
							<div className="plx-pluginCatalog__sectionHeading">
								<Text className="plx-pluginCatalog__sectionTitle">我的分组</Text>
								<Text className="plx-pluginCatalog__sectionMetric">{groups.length} 个</Text>
							</div>
						</div>
						<Text className="plx-pluginCatalog__sectionNote">
							{groups.length > 0 && showFlatResults
								? '筛选或长列表模式下暂时隐藏分组卡，清空筛选后恢复分组编辑。'
								: '暂无分组，可在上方创建。'}
						</Text>
					</Card>
				)}
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

			<GroupEditorModal
				opened={groupEditor !== null}
				title={groupEditor?.mode === 'rename' ? '重命名分组' : '新建分组'}
				description={
					groupEditor?.mode === 'rename'
						? '更新分组名称，不会影响当前插件归属。'
						: groupEditor?.pluginIds?.length
							? `把当前选中的 ${groupEditor.pluginIds.length} 个插件收拢成一个新分组。`
							: '创建一个新的插件分组，后续可把插件拖进去。'
				}
				confirmLabel={groupEditor?.mode === 'rename' ? '保存' : '创建'}
				initialValue={groupEditor?.initialName ?? ''}
				onClose={() => setGroupEditor(null)}
				onSubmit={handleGroupEditorSubmit}
			/>

			<GroupPlacementModal
				opened={placementModalOpen}
				count={selectedCount}
				options={groupPlacementOptions}
				onClose={() => setPlacementModalOpen(false)}
				onSubmit={moveSelectedPlugins}
			/>
		</DndContext>
	)
}
