import type React from 'react'
import { memo, useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { nanoid } from 'nanoid'
import {
	Menu,
	Card,
	Text,
	Group,
	Badge,
	Stack,
	Collapse,
	ActionIcon,
	Paper,
	useMantineTheme,
	Portal,
	Box,
	Anchor,
	Divider,
} from '@mantine/core'
import {
	DragDropContext,
	Droppable,
	Draggable,
	type DropResult,
	type DragStart,
} from '@hello-pangea/dnd'
import {
	IconFolderPlus,
	IconPencil,
	IconTrash,
	IconChevronDown,
	IconChevronRight,
} from '@tabler/icons-react'
import { showNotification } from '@mantine/notifications'

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
	/** 例如 React Router 的 Link；如果不给，则使用 <Anchor> */
	LinkComponent?: React.ComponentType<{ to: string; children: React.ReactNode }>
}

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

export function PluginOrganizer({
	statuses,
	initialGroups,
	onGroupsChange,
	filterQuery = '',
	LinkComponent,
}: Props) {
	const theme = useMantineTheme()

	// —— 基础派生 —— //
	const statusMap = useMemo(
		() => new Map(statuses.map((s) => [s.id, s] as const)),
		[statuses],
	)
	const allIds = useMemo(() => statuses.map((s) => s.id), [statuses])
	const { groups: saneGroups, ungrouped: saneUngrouped } = useMemo(
		() => sanitize(allIds, initialGroups),
		[allIds, initialGroups],
	)

	// —— 状态 —— //
	const [groups, setGroups] = useState<GroupConfig[]>(saneGroups)
	const [ungroupedOrder, setUngroupedOrder] = useState<string[]>(saneUngrouped)
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())

	// 拖拽浮层
	const [dragCount, setDragCount] = useState(0)
	const overlayRef = useRef<HTMLDivElement | null>(null)
	const rafRef = useRef<number | null>(null)
	const dragCleanupRef = useRef<(() => void) | null>(null)

	// 便于回调拿最新选中
	const selectedRef = useRef<string[]>([])
	useEffect(() => {
		selectedRef.current = selectedIds
	}, [selectedIds])

	// 右键菜单（用 groupId 精确定位）
	const [contextMenu, setContextMenu] = useState<{
		open: boolean
		x: number
		y: number
		type: 'ROOT' | 'GROUP'
		targetGroupId?: string
	}>({ open: false, x: 0, y: 0, type: 'ROOT' })

	// 外部数据变化：温和同步
	useEffect(() => {
		setGroups(saneGroups)
		setUngroupedOrder((prev) => {
			const set = new Set(saneUngrouped)
			const kept = prev.filter((id) => set.has(id))
			const added = saneUngrouped.filter((id) => !kept.includes(id))
			return [...kept, ...added]
		})
	}, [saneGroups, saneUngrouped])

	// —— 搜索 —— //
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

	// —— 快速集合/索引 —— //
	const assignedSet = useMemo(() => {
		const s = new Set<string>()
		for (const g of groups) for (const id of g.pluginIds) s.add(id)
		return s
	}, [groups])

	const groupNameById = useMemo(() => {
		const m = new Map<string, string>()
		for (const g of groups) m.set(g.groupId, g.name)
		return m
	}, [groups])

	// —— 可视数据 —— //
	const visibleUngrouped = useMemo(
		() => ungroupedOrder.filter((id) => !assignedSet.has(id)).filter(match),
		[ungroupedOrder, assignedSet, match],
	)
	const visibleGroups = useMemo(
		() => groups.map((g) => ({ ...g, pluginIds: g.pluginIds.filter(match) })),
		[groups, match],
	)

	// —— 右键菜单 —— //
	const closeMenu = useCallback(
		() => setContextMenu((m) => ({ ...m, open: false })),
		[],
	)
	useEffect(() => {
		if (!contextMenu.open) return
		const handle = () => closeMenu()
		document.addEventListener('mousedown', handle)
		return () => document.removeEventListener('mousedown', handle)
	}, [contextMenu.open, closeMenu])

	const handleContextMenu = useCallback(
		(e: React.MouseEvent, type: 'ROOT' | 'GROUP', targetGroupId?: string) => {
			e.preventDefault()
			e.stopPropagation() // 防止冒泡到外层 ROOT
			setContextMenu({
				open: true,
				x: e.clientX,
				y: e.clientY,
				type,
				targetGroupId,
			})
		},
		[],
	)

	// —— 折叠 —— //
	const toggleCollapse = useCallback((groupId: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev)
			next.has(groupId) ? next.delete(groupId) : next.add(groupId)
			return next
		})
	}, [])

	// —— 组操作（按 id 定位） —— //
	const createGroup = useCallback(() => {
		const name = prompt('请输入新文件夹名称：')?.trim()
		if (!name) return
		const newG: GroupConfig = { groupId: nanoid(), name, pluginIds: [] }
		setGroups((prev) => {
			const next = [...prev, newG]
			onGroupsChange(next)
			return next
		})
		closeMenu()
	}, [onGroupsChange, closeMenu])

	const renameGroup = useCallback(() => {
		const gid = contextMenu.targetGroupId
		if (!gid) return
		const idx = groups.findIndex((g) => g.groupId === gid)
		if (idx < 0) return
		const name = prompt('重命名文件夹：', groups[idx].name)?.trim()
		if (!name) return
		setGroups((prev) => {
			const next = prev.map((g, i) => (i === idx ? { ...g, name } : g))
			onGroupsChange(next)
			return next
		})
		closeMenu()
	}, [contextMenu.targetGroupId, groups, onGroupsChange, closeMenu])

	const deleteGroup = useCallback(() => {
		const gid = contextMenu.targetGroupId
		if (!gid) return
		const idx = groups.findIndex((g) => g.groupId === gid)
		if (idx < 0) return
		const victim = groups[idx]
		const count = victim?.pluginIds.length ?? 0
		if (
			!confirm(
				`删除文件夹「${victim?.name}」？\n将把其中 ${count} 个插件移入“未分组”。`,
			)
		)
			return
		setGroups((prev) => {
			const removed = prev[idx]!
			const next = prev.filter((_, i) => i !== idx)
			setUngroupedOrder((uo) => [...uo, ...removed.pluginIds])
			onGroupsChange(next)
			return next
		})
		closeMenu()
	}, [contextMenu.targetGroupId, groups, onGroupsChange, closeMenu])

	// —— 选择 —— //
	const handlePluginClick = useCallback((e: React.MouseEvent, id: string) => {
		setSelectedIds((sel) =>
			e.ctrlKey || e.metaKey
				? sel.includes(id)
					? sel.filter((x) => x !== id)
					: [...sel, id]
				: [id],
		)
	}, [])

	// —— 工具 —— //
	const reorder = useCallback(<T,>(arr: T[], from: number, to: number): T[] => {
		const copy = [...arr]
		const [m] = copy.splice(from, 1)
		copy.splice(to, 0, m)
		return copy
	}, [])

	// —— 拖拽 —— //
	const onBeforeDragStart = useCallback(({ draggableId }: DragStart) => {
		const current = selectedRef.current.includes(draggableId)
			? selectedRef.current
			: [draggableId]
		setSelectedIds(current)
		setDragCount(current.length)

		const move = (e: MouseEvent) => {
			if (!overlayRef.current) return
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
			rafRef.current = requestAnimationFrame(() => {
				overlayRef.current!.style.transform = `translate3d(${e.clientX + 12}px, ${e.clientY + 12}px, 0)`
			})
		}
		document.addEventListener('mousemove', move)
		dragCleanupRef.current = () => {
			document.removeEventListener('mousemove', move)
			if (rafRef.current != null) cancelAnimationFrame(rafRef.current)
		}
	}, [])

	const handleDragEnd = useCallback(
		({ source, destination, draggableId, type }: DropResult) => {
			// 清理监听 & 复位浮层
			dragCleanupRef.current?.()
			dragCleanupRef.current = null
			if (overlayRef.current) {
				overlayRef.current.style.transform = 'translate3d(-9999px, -9999px, 0)'
			}
			setDragCount(0)

			if (!destination) return

			// 组排序
			if (type === 'GROUP') {
				setGroups((prev) => {
					const next = reorder(prev, source.index, destination.index)
					onGroupsChange(next)
					return next
				})
				return
			}

			const moving =
				selectedRef.current.length > 1 &&
				selectedRef.current.includes(draggableId)
					? selectedRef.current
					: [draggableId]

			// 未分组内 reorder
			if (
				source.droppableId === 'ROOT_UNGROUPED' &&
				destination.droppableId === 'ROOT_UNGROUPED'
			) {
				setUngroupedOrder((prev) =>
					reorder(prev, source.index, destination.index),
				)
				showNotification({
					message: `已重新排序 ${moving.length} 项`,
					color: 'gray',
				})
				return
			}

			// 组 → 未分组
			if (
				source.droppableId !== 'ROOT_UNGROUPED' &&
				destination.droppableId === 'ROOT_UNGROUPED'
			) {
				setGroups((prev) => {
					const next = prev.map((g) => ({
						...g,
						pluginIds: g.pluginIds.filter((id) => !moving.includes(id)),
					}))
					onGroupsChange(next)
					return next
				})
				setUngroupedOrder((uo) => {
					const next = [...uo]
					next.splice(destination.index, 0, ...moving)
					return next
				})
				showNotification({
					message: `已移动 ${moving.length} 项 → 未分组`,
					color: 'blue',
				})
				return
			}

			// 未分组 → 组
			if (
				source.droppableId === 'ROOT_UNGROUPED' &&
				destination.droppableId !== 'ROOT_UNGROUPED'
			) {
				setUngroupedOrder((uo) => uo.filter((id) => !moving.includes(id)))
				setGroups((prev) => {
					const next = prev.map((g) => ({ ...g, pluginIds: [...g.pluginIds] }))
					const tgt = next.find((g) => g.groupId === destination.droppableId)!
					tgt.pluginIds.splice(destination.index, 0, ...moving)
					onGroupsChange(next)
					return next
				})
				showNotification({
					message: `已移动 ${moving.length} 项 → ${groupNameById.get(destination.droppableId)}`,
					color: 'blue',
				})
				return
			}

			// 组 ↔ 组（或同组内重排）
			setGroups((prev) => {
				const next = prev.map((g) => ({ ...g, pluginIds: [...g.pluginIds] }))
				next.forEach((g) => {
					for (const id of moving) {
						const i = g.pluginIds.indexOf(id)
						if (i > -1) g.pluginIds.splice(i, 1)
					}
				})
				const tgt = next.find((g) => g.groupId === destination.droppableId)!
				tgt.pluginIds.splice(destination.index, 0, ...moving)
				onGroupsChange(next)
				return next
			})
			showNotification({
				message: `已移动 ${moving.length} 项 → ${groupNameById.get(destination.droppableId)}`,
				color: 'blue',
			})
		},
		[onGroupsChange, reorder, groupNameById],
	)

	// —— 计数 —— //
	const countGroup = useCallback(
		(ids: string[]) => {
			const total = ids.length
			let running = 0
			for (const id of ids) if (statusMap.get(id)?.isRunning) running++
			return { total, running }
		},
		[statusMap],
	)

	// —— 条目 —— //
	const PluginRow = memo(function PluginRow({
		id,
		idx,
		link,
		isSelected,
		onClick,
	}: {
		id: string
		idx: number
		link?: React.ComponentType<{ to: string; children: React.ReactNode }>
		isSelected: boolean
		onClick: (e: React.MouseEvent, id: string) => void
	}) {
		const st = statusMap.get(id)
		const name = st?.name ?? id
		const Link = link

		return (
			<Draggable draggableId={id} index={idx} isDragDisabled={isFiltering}>
				{(prov) => (
					<Box
						ref={prov.innerRef}
						{...prov.draggableProps}
						{...prov.dragHandleProps}
						onClick={(e) => onClick(e, id)}
						style={{
							...(prov.draggableProps.style as React.CSSProperties),
							cursor: isFiltering ? 'default' : 'move',
						}}
					>
						<Paper
							withBorder
							radius="md"
							p="xs"
							data-selected={isSelected || undefined}
							style={{
								outline: isSelected
									? `2px solid ${theme.colors.blue[6]}`
									: undefined,
								outlineOffset: isSelected ? -2 : undefined,
							}}
						>
							<Group
								justify="space-between"
								align="center"
								gap="sm"
								wrap="nowrap"
							>
								{LinkComponent ? (
									<LinkComponent to={`/plugins/${id}`}>
										<Text size="sm">{name}</Text>
									</LinkComponent>
								) : (
									<Anchor size="sm" href={`/plugins/${id}`} underline="never">
										{name}
									</Anchor>
								)}
								{st && (
									<Badge variant="dot" color={st.isRunning ? 'green' : 'gray'}>
										{st.isRunning ? '运行中' : '已停止'}
									</Badge>
								)}
							</Group>
						</Paper>
					</Box>
				)}
			</Draggable>
		)
	})

	// —— 悬浮提示（仅拖拽时渲染） —— //
	const DragOverlay = (
		<Portal>
			<Box
				ref={overlayRef}
				pos="fixed"
				left={0}
				top={0}
				style={{
					transform: 'translate3d(-9999px, -9999px, 0)',
					pointerEvents: 'none',
					zIndex: 1000,
				}}
			>
				<Paper withBorder radius="sm" p="xs" shadow="md">
					<Group gap="xs">
						<Badge variant="filled" size="sm">
							{dragCount}
						</Badge>
						<Text size="sm">拖动中</Text>
					</Group>
				</Paper>
			</Box>
		</Portal>
	)

	// —— 统计 —— //
	const ungroupedIds = useMemo(
		() => ungroupedOrder.filter((id) => !assignedSet.has(id)),
		[ungroupedOrder, assignedSet],
	)
	const { total: ungroupedTotal, running: ungroupedRunning } = countGroup(
		ungroupedIds.filter(match),
	)
	const visGroupStats = visibleGroups.map((g) => ({
		id: g.groupId,
		...countGroup(g.pluginIds),
	}))

	return (
		<Stack gap="sm" onContextMenu={(e) => handleContextMenu(e, 'ROOT')}>
			{/* 右键菜单：根 */}
			<Menu
				opened={contextMenu.open && contextMenu.type === 'ROOT'}
				onClose={closeMenu}
				withinPortal
				zIndex={10000}
			>
				<Menu.Dropdown
					style={{
						position: 'fixed',
						top: contextMenu.y,
						left: contextMenu.x,
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

			{/* 右键菜单：组（确保始终能看到“删除文件夹”） */}
			<Menu
				opened={contextMenu.open && contextMenu.type === 'GROUP'}
				onClose={closeMenu}
				withinPortal
				zIndex={10000}
			>
				<Menu.Dropdown
					style={{
						position: 'fixed',
						top: contextMenu.y,
						left: contextMenu.x,
						minWidth: 200,
					}}
				>
					<Menu.Label>文件夹</Menu.Label>
					<Menu.Item
						leftSection={<IconPencil size={16} />}
						onClick={renameGroup}
						disabled={!contextMenu.targetGroupId}
					>
						重命名
					</Menu.Item>
					<Menu.Item
						leftSection={<IconTrash size={16} />}
						onClick={deleteGroup}
						color="red"
						disabled={!contextMenu.targetGroupId}
					>
						删除文件夹
					</Menu.Item>
				</Menu.Dropdown>
			</Menu>

			{dragCount > 0 && DragOverlay}

			<DragDropContext
				onBeforeDragStart={onBeforeDragStart}
				onDragEnd={handleDragEnd}
			>
				{/* 未分组 */}
				<Droppable
					droppableId="ROOT_UNGROUPED"
					type="ITEM"
					isDropDisabled={isFiltering}
				>
					{(prov, snapshot) => (
						<Card
							withBorder
							radius="md"
							ref={prov.innerRef}
							{...prov.droppableProps}
							p="md"
						>
							<Group
								justify="space-between"
								align="center"
								mb="xs"
								wrap="nowrap"
							>
								<Group gap="xs" align="center">
									<Text fw={600}>未分组</Text>
									<Badge variant="light" size="sm">
										{ungroupedTotal}
									</Badge>
									<Badge variant="light" size="sm" color="green">
										{ungroupedRunning}
									</Badge>
									{snapshot.isDraggingOver && dragCount > 0 && (
										<Badge variant="filled" size="sm" color="blue">
											+{dragCount}
										</Badge>
									)}
								</Group>
							</Group>

							<Stack gap="xs">
								{visibleUngrouped.map((id, idx) => (
									<PluginRow
										key={id}
										id={id}
										idx={idx}
										link={LinkComponent}
										isSelected={selectedIds.includes(id)}
										onClick={handlePluginClick}
									/>
								))}
								{prov.placeholder}
								{visibleUngrouped.length === 0 && (
									<Text c="dimmed" size="xs">
										（空）
									</Text>
								)}
							</Stack>
						</Card>
					)}
				</Droppable>

				<Divider variant="dashed" />

				{/* 分组容器（可重排组本身） */}
				<Droppable droppableId="ROOT" type="GROUP" isDropDisabled={isFiltering}>
					{(provG) => (
						<Stack ref={provG.innerRef} {...provG.droppableProps} gap="md">
							{visibleGroups.map((g, idx) => {
								const collapsed = collapsedGroups.has(g.groupId)
								const stat = visGroupStats[idx]
								return (
									<Draggable
										key={g.groupId}
										draggableId={g.groupId}
										index={idx}
										isDragDisabled={isFiltering}
									>
										{(grpProv) => (
											<Card
												withBorder
												radius="md"
												ref={grpProv.innerRef}
												{...grpProv.draggableProps}
												p="md"
												onContextMenu={(e) =>
													handleContextMenu(e, 'GROUP', g.groupId)
												}
											>
												<Group
													justify="space-between"
													align="center"
													wrap="nowrap"
													{...grpProv.dragHandleProps}
												>
													<Group gap="xs" align="center">
														<ActionIcon
															size="sm"
															variant="subtle"
															onClick={() => toggleCollapse(g.groupId)}
															aria-label="切换折叠"
														>
															{collapsed ? (
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

												<Collapse in={!collapsed}>
													<Droppable
														droppableId={g.groupId}
														type="ITEM"
														isDropDisabled={isFiltering}
													>
														{(prov2, snapshot) => (
															<Stack
																ref={prov2.innerRef}
																{...prov2.droppableProps}
																gap="xs"
																mt="sm"
															>
																{snapshot.isDraggingOver && dragCount > 0 && (
																	<Badge
																		align="self-start"
																		variant="filled"
																		size="sm"
																		color="blue"
																	>
																		+{dragCount}
																	</Badge>
																)}
																{g.pluginIds.map((id, i) => (
																	<PluginRow
																		key={id}
																		id={id}
																		idx={i}
																		link={LinkComponent}
																		isSelected={selectedIds.includes(id)}
																		onClick={handlePluginClick}
																	/>
																))}
																{prov2.placeholder}
																{g.pluginIds.length === 0 && (
																	<Text c="dimmed" size="xs">
																		（空）
																	</Text>
																)}
															</Stack>
														)}
													</Droppable>
												</Collapse>
											</Card>
										)}
									</Draggable>
								)
							})}
							{provG.placeholder}
						</Stack>
					)}
				</Droppable>
			</DragDropContext>
		</Stack>
	)
}
