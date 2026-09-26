/** Plugin catalog layout, selection, filtering and drag-and-drop organization. */

import { pluginDefinitionIndexKey } from '@pluxel/core'
import { closestCorners, DndContext, DragOverlay, MeasuringStrategy } from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ActionIcon, Badge, Box, Card, ScrollArea, Stack, Text, Tooltip } from '@mantine/core'
import { IconArrowsShuffle, IconFolderMinus, IconFolders } from '@tabler/icons-react'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type ComponentPropsWithoutRef,
	type ComponentType,
	type CSSProperties,
	type ReactNode,
} from 'react'
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
import { SortableRow, type RowMeta } from './components/SortableRow'
import { cid, gid, iid } from './controllerModel'
import { DENSITY, FILTERED_FLAT_VIRTUALIZE_THRESHOLD, type Density } from './constants'
import type { GroupConfig, PluginStatuses } from './types'
import { arraysEqual, COLLAPSE_STORAGE_KEY, readCollapsedState, sanitize } from './organizerModel'
import { movePluginIdsToTarget, sortPluginIdsByOrder } from './groupOperations'
import { usePluginOrganizerDnd } from './usePluginOrganizerDnd'
import { usePluginSelectionController } from './usePluginSelectionController'

export type { GroupConfig, PluginStatus, PluginStatuses } from './types'

export type StatusFilter = {
	running: boolean
	stopped: boolean
	unavailable: boolean
}

type Props = {
	statuses: PluginStatuses
	initialGroups: GroupConfig[]
	onGroupsChange: (groups: GroupConfig[]) => void
	onResetGroups?: () => void
	filterQuery?: string
	statusFilter?: StatusFilter
	LinkComponent?: ComponentType<
		{
			to: string
			children: ReactNode
		} & Omit<ComponentPropsWithoutRef<'a'>, 'href'>
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
	style?: CSSProperties
}

const COMPACT_UNGROUPED_MAX_ITEMS = 2
const COMPACT_UNGROUPED_CHROME_HEIGHT = 38
const MIN_SECTION_HEIGHT = 72

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
	onResetGroups,
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
		for (const [id, status] of Object.entries(statuses)) {
			if (status.lifecycleState === 'running') s.add(id)
		}
		return s
	}, [statuses])
	const availableSet = useMemo(() => {
		const s = new Set<string>()
		for (const [id, status] of Object.entries(statuses)) {
			if (status.availability === 'available') s.add(id)
		}
		return s
	}, [statuses])
	const desiredRunningSet = useMemo(() => {
		const s = new Set<string>()
		for (const [id, status] of Object.entries(statuses)) {
			if (status.desiredState === 'running') s.add(id)
		}
		return s
	}, [statuses])
	const getName = useCallback((id: string) => statuses[id]?.name ?? id, [statuses])
	const getMeta = useCallback(
		(id: string): RowMeta => {
			const status = statuses[id]
			return {
				failureLabel: status?.failureLabel,
				failureDescription: status?.failureDescription,
				definition: status?.definitionLabel,
				exportName: status?.exportName,
				reference: status?.reference,
				executionLabel: status?.executionLabel,
				executionTone: status?.executionTone,
				executionDescription: status?.executionDescription,
				recentUpdateWarningLabel: status?.recentUpdateWarningLabel,
				recentUpdateWarningTone: status?.recentUpdateWarningTone,
				recentUpdateWarningDescription: status?.recentUpdateWarningDescription,
			}
		},
		[statuses],
	)

	const allIds = useMemo(() => Object.keys(statuses), [statuses])
	const expandFamilies = useCallback(
		(ids: string[]) => {
			const definitions = new Set(
				ids
					.map((id) => statuses[id])
					.filter(Boolean)
					.map((status) => pluginDefinitionIndexKey(status.address.definition)),
			)
			return allIds.filter((id) =>
				definitions.has(pluginDefinitionIndexKey(statuses[id]!.address.definition)),
			)
		},
		[allIds, statuses],
	)
	const { groups: saneGroups, ungrouped: saneUngrouped } = useMemo(
		() => sanitize(allIds, initialGroups),
		[allIds, initialGroups],
	)

	// —— 本地优先：只在首次挂载吃初始值 —— //
	const [groups, setGroups] = useState<GroupConfig[]>(() => saneGroups)
	const [ungroupedOrder, setUngroupedOrder] = useState<string[]>(() => saneUngrouped)
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readCollapsedState())
	const [editorOpen, setEditorOpen] = useState(false)
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

	const ungroupedDisplayOrder = visibleUngrouped

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
				expandFamilies(selectedIds),
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
		[emitGroupsChange, expandFamilies, selectedIds],
	)

	const { dragActiveId, groupIdsSortable, handleDragEnd, handleDragStart, sensors } =
		usePluginOrganizerDnd({
			groups,
			expandFamilies,
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
	const organizerGridRows = useMemo(() => {
		if (groups.length === 0 || showFlatResults) return 'minmax(0, 1fr)'
		if (visibleUngrouped.length <= COMPACT_UNGROUPED_MAX_ITEMS) {
			const compactHeight =
				COMPACT_UNGROUPED_CHROME_HEIGHT + Math.max(1, visibleUngrouped.length) * dh.rowH
			return `${compactHeight}px minmax(0, 1fr)`
		}

		const groupedRows = visibleGroups.reduce(
			(total, group) => total + 1 + (collapsed[group.groupId] ? 0 : group.pluginIds.length),
			0,
		)
		return `minmax(${MIN_SECTION_HEIGHT}px, ${visibleUngrouped.length}fr) minmax(${MIN_SECTION_HEIGHT}px, ${Math.max(1, groupedRows)}fr)`
	}, [collapsed, dh.rowH, groups.length, showFlatResults, visibleGroups, visibleUngrouped.length])

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCorners}
			modifiers={[restrictToVerticalAxis]}
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			{/* 根：有分组时分配双区高度，否则让唯一列表占满。 */}
			<Box
				ref={containerRef}
				className={className}
				tabIndex={0}
				style={{
					display: 'grid',
					gridTemplateRows: organizerGridRows,
					gap: 4,
					minHeight: 0,
					height: '100%',
					...style,
				}}
				onClick={handleBackgroundClick}
				onKeyDown={handleKeyDown}
				aria-label="插件列表与分组"
			>
				{/* 默认显示未分组；无分组时即为完整插件列表。 */}
				<Card
					className="plx-theme-panel plx-pluginCatalog__sectionCard"
					withBorder
					shadow="none"
					radius="sm"
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
								{showFlatResults ? '筛选结果' : groups.length > 0 ? '未分组' : '全部插件'}
							</Text>
							<Text
								className="plx-pluginCatalog__sectionMetric"
								title={
									showFlatResults
										? `${flatVisibleRunning} 个运行中，共 ${flatVisibleIds.length} 个筛选结果`
										: `${visibleUngroupedRunning} 个运行中，共 ${visibleUngrouped.length} 个插件`
								}
							>
								{showFlatResults
									? `${flatVisibleRunning}/${flatVisibleIds.length}`
									: `${visibleUngroupedRunning}/${visibleUngrouped.length}`}
							</Text>
						</div>
						<Box className="plx-pluginCatalog__sectionActions">
							<Tooltip label="编辑分组" withinPortal>
								<ActionIcon
									aria-label="编辑分组"
									size="sm"
									variant="subtle"
									disabled={locked || isFiltering}
									onClick={() => setEditorOpen(true)}
								>
									<IconFolders size={14} />
								</ActionIcon>
							</Tooltip>
							{selectedCount > 0 ? (
								<>
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
											<IconFolderMinus size={14} />
										</ActionIcon>
									</Tooltip>
								</>
							) : null}
						</Box>
					</div>

					{showFlatResults ? (
						<FlatPluginList
							ids={flatVisibleIds}
							virtualize={shouldVirtualizeFlatResults}
							runningSet={runningSet}
							availableSet={availableSet}
							desiredRunningSet={desiredRunningSet}
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
								<Stack
									gap={0}
									align="stretch"
									role="list"
									aria-label={groups.length > 0 ? '未分组插件' : '全部插件'}
								>
									{ungroupedDisplayOrder.map((id) => (
										<SortableRow
											key={id}
											pid={id}
											name={getName(id)}
											running={runningSet.has(id)}
											available={availableSet.has(id)}
											desiredRunning={desiredRunningSet.has(id)}
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
								</Stack>
							</SortableContext>
						</DroppableContainer>
					)}
				</Card>

				{/* 分类只在可编辑且实际存在时占用空间。 */}
				{groups.length > 0 && !showFlatResults ? (
					<Card
						className="plx-theme-panel plx-pluginCatalog__sectionCard"
						withBorder
						shadow="none"
						radius="sm"
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
									<Text className="plx-pluginCatalog__sectionTitle">插件分类</Text>
									<Text className="plx-pluginCatalog__sectionMetric">
										{visibleGroups.length} 个
									</Text>
								</div>
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
													没有匹配当前筛选的分类。
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
															availableSet={availableSet}
															desiredRunningSet={desiredRunningSet}
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
				) : null}
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
				opened={editorOpen}
				groups={groups}
				onReset={
					onResetGroups
						? () => {
								setEditorOpen(false)
								onResetGroups()
							}
						: undefined
				}
				onClose={() => setEditorOpen(false)}
				onSubmit={(next) => {
					const assigned = new Set(next.flatMap((group) => group.pluginIds))
					setGroups(next)
					setUngroupedOrder(allIds.filter((id) => !assigned.has(id)))
					emitGroupsChange(next)
					setEditorOpen(false)
				}}
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
