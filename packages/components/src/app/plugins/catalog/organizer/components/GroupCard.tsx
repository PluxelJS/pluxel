import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import {
	ActionIcon,
	Badge,
	Box,
	Collapse,
	Flex,
	Group,
	Menu,
	Stack,
	Text,
	Tooltip,
} from '@mantine/core'
import {
	IconChevronDown,
	IconChevronRight,
	IconDotsVertical,
	IconGripVertical,
	IconPencil,
	IconTrash,
} from '@tabler/icons-react'
import type { UniqueIdentifier } from '@dnd-kit/core'
import type React from 'react'
import { memo, useMemo } from 'react'
import type { WorkbenchNavigationRequest } from '../../../../workbench/context'
import type { GroupConfig } from '../types'
import type { RowDensity } from '../constants'
import { DroppableContainer } from './DroppableContainer'
import { SortableRow } from './SortableRow'

type Props = {
	g: GroupConfig
	visibleIds: string[]
	runningSet: Set<string>
	enabledSet: Set<string>
	selectedSet: Set<string>
	activeSet: Set<string>
	focusedId: string | null
	onSelect: (e: React.MouseEvent, id: string, mode?: 'click' | 'context' | 'toggle') => void
	LinkComp?: React.ComponentType<
		{
			to: string
			children: React.ReactNode
			workbenchMode?: WorkbenchNavigationRequest
		} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>
	>
	sortableId: UniqueIdentifier
	droppableId: UniqueIdentifier
	isFiltering: boolean
	isCollapsed: boolean
	toggleCollapse: () => void
	getName: (id: string) => string
	getMeta: (id: string) => { tag?: string; version?: string }
	getItemSortableId: (id: string) => UniqueIdentifier
	dh: RowDensity
	onRename: (gid: string) => void
	onDelete: (gid: string) => void
	locked: boolean
}

export const GroupCard = memo(function GroupCard(props: Props) {
	const {
		g,
		visibleIds,
		runningSet,
		enabledSet,
		selectedSet,
		activeSet,
		focusedId,
		onSelect,
		LinkComp,
		sortableId,
		droppableId,
		isFiltering,
		isCollapsed,
		toggleCollapse,
		getName,
		getMeta,
		getItemSortableId,
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

	const stat = useMemo(
		() => ({
			total: visibleIds.length,
			running: visibleIds.filter((id) => runningSet.has(id)).length,
		}),
		[visibleIds, runningSet],
	)
	const collapseLabel = isCollapsed ? '展开分组' : '折叠分组'

	return (
		<Box
			ref={setNodeRef}
			className="plx-theme-panel"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition: transition ?? 'opacity 120ms ease-out',
				minWidth: 0,
				padding: 6,
				borderRadius: 10,
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
								style={{
									whiteSpace: 'nowrap',
									overflow: 'hidden',
									textOverflow: 'ellipsis',
									color: 'var(--plx-text)',
								}}
							>
								{g.name || '未命名分组'}
							</Text>
						</Tooltip>
					</Box>
					<Badge
						size="xs"
						variant="light"
						color={stat.running > 0 ? 'brand' : 'gray'}
						style={{ flexShrink: 0, whiteSpace: 'nowrap' }}
					>
						{stat.running}/{stat.total}
					</Badge>
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
				id={droppableId}
				disabled={isFiltering || locked}
				minDropHeight={isCollapsed ? 10 : dh.rowH}
			>
				<Collapse in={!isCollapsed}>
					<SortableContext
						items={visibleIds.map((id) => getItemSortableId(id))}
						strategy={verticalListSortingStrategy}
					>
						<Stack gap={0} mt={6} align="stretch" role="list" aria-label="插件列表">
							{visibleIds.map((id) => (
								<SortableRow
									key={id}
									pid={id}
									name={getName(id)}
									running={runningSet.has(id)}
									enabled={enabledSet.has(id)}
									selected={selectedSet.has(id)}
									active={activeSet.has(id)}
									focused={focusedId === id}
									onSelect={onSelect}
									LinkComp={LinkComp}
									dragDisabled={isFiltering || locked}
									meta={getMeta(id)}
									dh={dh}
									sortableId={getItemSortableId(id)}
								/>
							))}
						</Stack>
					</SortableContext>
				</Collapse>
			</DroppableContainer>
		</Box>
	)
})
