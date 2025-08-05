import type React from 'react'
import { useState, useCallback, useMemo, useEffect } from 'react'
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
	ScrollArea,
	useMantineTheme,
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
	IconPlus,
	IconTrash,
	IconChevronDown,
	IconChevronRight,
} from '@tabler/icons-react'

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
	onGroupsChange: (groups: GroupConfig[]) => void // ← CHANGED: 重命名 onChange
	LinkComponent?: React.ComponentType<{
		to: string
		children: React.ReactNode
	}>
}

export function PluginOrganizer({
	statuses,
	initialGroups,
	onGroupsChange, // ← CHANGED
	LinkComponent,
}: Props) {
	const theme = useMantineTheme()

	// — state —
	const [groups, setGroups] = useState<GroupConfig[]>(initialGroups)
	const [ungroupedOrder, setUngroupedOrder] = useState<string[]>(() =>
		statuses
			.map((s) => s.id)
			.filter((id) => !initialGroups.some((g) => g.pluginIds.includes(id))),
	)
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(new Set())
	const [contextMenu, setContextMenu] = useState({
		open: false,
		x: 0,
		y: 0,
		type: 'ROOT' as 'ROOT' | 'GROUP',
		targetIndex: undefined as number | undefined,
	})

	const statusMap = useMemo(
		() => new Map(statuses.map((s) => [s.id, s] as const)),
		[statuses],
	)

	// — 样式提炼 —
	const containerStyle = useMemo(
		() => ({
			display: 'flex',
			flexDirection: 'column' as const,
			paddingRight: 4,
			minHeight: 48,
		}),
		[],
	)
	const highlightStyle = useMemo(
		() => ({
			outline: `2px solid ${theme.colors.blue[6]}`,
			outlineOffset: '-2px' as const,
		}),
		[theme],
	)

	// — context menu 控制 —
	const closeMenu = useCallback(
		() => setContextMenu((m) => ({ ...m, open: false })),
		[],
	)
	useEffect(() => {
		if (!contextMenu.open) return
		const handleClick = () => closeMenu()
		document.addEventListener('mousedown', handleClick)
		return () => document.removeEventListener('mousedown', handleClick)
	}, [contextMenu.open, closeMenu])

	const handleContextMenu = useCallback(
		(e: React.MouseEvent, type: 'ROOT' | 'GROUP', targetIndex?: number) => {
			e.preventDefault()
			setContextMenu({
				open: true,
				x: e.clientX,
				y: e.clientY,
				type,
				targetIndex,
			})
		},
		[],
	)

	// — 折叠切换 —
	const toggleCollapse = useCallback((groupId: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev)
			next.has(groupId) ? next.delete(groupId) : next.add(groupId)
			return next
		})
	}, [])

	// — group 操作：创建 & 删除 —
	const createGroup = useCallback(() => {
		const name = prompt('请输入新文件夹名称：')?.trim()
		if (!name) return
		const newG: GroupConfig = { groupId: nanoid(), name, pluginIds: [] }
		setGroups((prev) => {
			const next = [...prev, newG]
			onGroupsChange(next) // ← CHANGED: 只在最终添加时回调
			return next
		})
		closeMenu()
	}, [onGroupsChange, closeMenu])

	const deleteGroup = useCallback(() => {
		const idx = contextMenu.targetIndex
		if (idx == null) return
		setGroups((prev) => {
			const removed = prev[idx]
			const next = prev.filter((_, i) => i !== idx)
			setUngroupedOrder((uo) => [...uo, ...removed.pluginIds])
			onGroupsChange(next) // ← CHANGED: 回调父组件
			return next
		})
		closeMenu()
	}, [contextMenu.targetIndex, onGroupsChange, closeMenu])

	// — selection & drag helpers —
	const handlePluginClick = useCallback((e: React.MouseEvent, id: string) => {
		setSelectedIds((sel) =>
			e.ctrlKey || e.metaKey
				? sel.includes(id)
					? sel.filter((x) => x !== id)
					: [...sel, id]
				: [id],
		)
	}, [])

	const reorder = useCallback(<T,>(arr: T[], from: number, to: number): T[] => {
		const copy = [...arr]
		const [m] = copy.splice(from, 1)
		copy.splice(to, 0, m)
		return copy
	}, [])

	const onBeforeDragStart = useCallback(
		({ draggableId }: DragStart) => {
			if (!selectedIds.includes(draggableId)) setSelectedIds([draggableId])
		},
		[selectedIds],
	)

	const handleDragEnd = useCallback(
		({ source, destination, draggableId, type }: DropResult) => {
			if (!destination) return

			// — 分组 reorder —
			if (type === 'GROUP') {
				setGroups((prev) => {
					const next = reorder(prev, source.index, destination.index)
					onGroupsChange(next) // ← CHANGED
					return next
				})
				return
			}

			// 准备要移动的一批 id
			const moving =
				selectedIds.length > 1 && selectedIds.includes(draggableId)
					? selectedIds
					: [draggableId]

			// —— 1. 同组未分组内 reorder ——
			if (
				source.droppableId === 'ROOT_UNGROUPED' &&
				destination.droppableId === 'ROOT_UNGROUPED'
			) {
				setUngroupedOrder((prev) =>
					reorder(prev, source.index, destination.index),
				)
				return
			}

			// —— 2. 组 → 未分组 ——
			if (
				source.droppableId !== 'ROOT_UNGROUPED' &&
				destination.droppableId === 'ROOT_UNGROUPED'
			) {
				setGroups((prev) => {
					const next = prev.map((g) => ({
						...g,
						pluginIds: g.pluginIds.filter((id) => !moving.includes(id)),
					}))
					onGroupsChange(next) // ← CHANGED
					return next
				})
				setUngroupedOrder((uo) => {
					const next = [...uo]
					next.splice(destination.index, 0, ...moving)
					return next
				})
				return
			}

			// —— 3. 未分组 → 组 ——
			if (
				source.droppableId === 'ROOT_UNGROUPED' &&
				destination.droppableId !== 'ROOT_UNGROUPED'
			) {
				setUngroupedOrder((uo) => uo.filter((id) => !moving.includes(id)))
				setGroups((prev) => {
					const next = prev.map((g) => ({ ...g, pluginIds: [...g.pluginIds] }))
					const tgt = next.find((g) => g.groupId === destination.droppableId)!
					tgt.pluginIds.splice(destination.index, 0, ...moving)
					onGroupsChange(next) // ← CHANGED
					return next
				})
				return
			}

			// —— 4. 组 → 组 ——
			setGroups((prev) => {
				const next = prev.map((g) => ({ ...g, pluginIds: [...g.pluginIds] }))
				// 先移除
				next.forEach((g) =>
					moving.forEach((id) => {
						const i = g.pluginIds.indexOf(id)
						if (i > -1) g.pluginIds.splice(i, 1)
					}),
				)
				// 再插入到目标组
				const tgt = next.find((g) => g.groupId === destination.droppableId)!
				tgt.pluginIds.splice(destination.index, 0, ...moving)
				onGroupsChange(next) // ← CHANGED
				return next
			})
		},
		[reorder, selectedIds, onGroupsChange],
	)

	const ungroupedIds = useMemo(
		() =>
			ungroupedOrder.filter(
				(id) => !groups.some((g) => g.pluginIds.includes(id)),
			),
		[groups, ungroupedOrder],
	)

	// — 渲染单个插件卡片 —
	const renderPlugin = useCallback(
		(pid: string, idx: number) => {
			const st = statusMap.get(pid)
			const name = st?.name ?? pid
			const isSel = selectedIds.includes(pid)
			return (
				<Draggable key={pid} draggableId={pid} index={idx}>
					{(prov) => (
						<div
							ref={prov.innerRef}
							{...prov.draggableProps}
							{...prov.dragHandleProps}
							style={{ ...prov.draggableProps.style, cursor: 'move' }}
							onClick={(e) => handlePluginClick(e, pid)}
						>
							<Card
								withBorder
								mb="xs"
								style={isSel ? highlightStyle : undefined}
							>
								<Group align="apart">
									{LinkComponent ? (
										<LinkComponent to={`/plugins/${pid}`}>
											{' '}
											{/* ← CHANGED */}
											{name}
										</LinkComponent>
									) : (
										<Text size="md">{name}</Text>
									)}
									{st && (
										<Badge
											variant="dot"
											color={st.isRunning ? 'green' : 'gray'}
										>
											{st.isRunning ? 'Running' : 'Stopped'}
										</Badge>
									)}
								</Group>
							</Card>
						</div>
					)}
				</Draggable>
			)
		},
		[handlePluginClick, LinkComponent, selectedIds, statusMap, highlightStyle],
	)

	return (
		<Stack style={{ height: '100%', flex: 1 }}>
			{/* 根滚动区域 */}
			<ScrollArea style={{ height: '100%' }} scrollbarSize={6}>
				{/* ROOT 菜单 */}
				<Menu
					opened={contextMenu.open && contextMenu.type === 'ROOT'}
					onClose={closeMenu}
					withinPortal
					closeOnClickOutside
				>
					<Menu.Dropdown
						style={{
							position: 'fixed',
							top: contextMenu.y,
							left: contextMenu.x,
							minWidth: 150,
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

				{/* GROUP 菜单 */}
				<Menu
					opened={contextMenu.open && contextMenu.type === 'GROUP'}
					onClose={closeMenu}
					withinPortal
					closeOnClickOutside
				>
					<Menu.Dropdown
						style={{
							position: 'fixed',
							top: contextMenu.y,
							left: contextMenu.x,
							minWidth: 180,
						}}
					>
						<Menu.Label>文件夹操作</Menu.Label>
						<Menu.Item
							leftSection={<IconPlus size={16} />}
							onClick={createGroup}
						>
							新建子文件夹
						</Menu.Item>
						<Menu.Item
							leftSection={<IconTrash size={16} />}
							onClick={deleteGroup}
						>
							删除文件夹
						</Menu.Item>
					</Menu.Dropdown>
				</Menu>

				<DragDropContext
					onBeforeDragStart={onBeforeDragStart}
					onDragEnd={handleDragEnd}
				>
					{/* 未分组 列表 */}
					<Droppable droppableId="ROOT_UNGROUPED" type="ITEM">
						{(prov) => (
							<Card withBorder>
								<Group align="apart" mb="xs">
									<Text>未分组</Text>
								</Group>
								<div
									ref={prov.innerRef}
									{...prov.droppableProps}
									style={containerStyle}
									onContextMenu={(e) =>
										handleContextMenu(e, 'ROOT', groups.length)
									}
								>
									{ungroupedIds.map(renderPlugin)}
									{prov.placeholder}
								</div>
							</Card>
						)}
					</Droppable>

					{/* 分组 列表 */}
					<Droppable droppableId="ROOT" type="GROUP">
						{(provG) => (
							<div ref={provG.innerRef} {...provG.droppableProps}>
								{groups.map((g, idx) => (
									<Draggable
										key={g.groupId}
										draggableId={g.groupId}
										index={idx}
									>
										{(grpProv) => (
											<Card
												withBorder
												mb="md"
												ref={grpProv.innerRef}
												{...grpProv.draggableProps}
												style={grpProv.draggableProps.style}
												onContextMenu={(e) =>
													handleContextMenu(e, 'GROUP', idx)
												}
											>
												{/* 折叠开关 + 拖拽句柄 */}
												<Group
													align="center"
													gap="md"
													{...grpProv.dragHandleProps}
												>
													<ActionIcon
														size="sm"
														onClick={() => toggleCollapse(g.groupId)}
													>
														{collapsedGroups.has(g.groupId) ? (
															<IconChevronRight size={16} />
														) : (
															<IconChevronDown size={16} />
														)}
													</ActionIcon>
													<Text>{g.name}</Text>
												</Group>

												{/* 插件列表（可折叠） */}
												<Collapse in={!collapsedGroups.has(g.groupId)}>
													<Droppable droppableId={g.groupId} type="ITEM">
														{(prov2) => (
															<div
																ref={prov2.innerRef}
																{...prov2.droppableProps}
																style={containerStyle}
															>
																{g.pluginIds.map(renderPlugin)}
																{prov2.placeholder}
															</div>
														)}
													</Droppable>
												</Collapse>
											</Card>
										)}
									</Draggable>
								))}
								{provG.placeholder}
							</div>
						)}
					</Droppable>
				</DragDropContext>
			</ScrollArea>
		</Stack>
	)
}
