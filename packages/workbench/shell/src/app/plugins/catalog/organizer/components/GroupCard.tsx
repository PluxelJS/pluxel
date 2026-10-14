import { CatalogTooltip } from '../../components/CatalogTooltip'
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { ActionIcon, Box, Collapse, Flex, Group, Stack, Text } from '@mantine/core'
import { IconChevronDown, IconChevronRight, IconGripVertical } from '@tabler/icons-react'
import type { UniqueIdentifier } from '@dnd-kit/core'
import {
	memo,
	useMemo,
	type ComponentPropsWithoutRef,
	type ComponentType,
	type MouseEvent,
	type ReactNode,
} from 'react'
import type { GroupConfig } from '../types'
import type { RowDensity } from '../constants'
import { DroppableContainer } from './DroppableContainer'
import { SortableRow, type RowMeta } from './SortableRow'

type Props = {
	g: GroupConfig
	visibleIds: string[]
	runningSet: Set<string>
	availableSet: Set<string>
	desiredRunningSet: Set<string>
	selectedSet: Set<string>
	activeSet: Set<string>
	focusedId: string | null
	onSelect: (e: MouseEvent, id: string, mode?: 'click' | 'context' | 'toggle') => void
	LinkComp?: ComponentType<
		{
			to: string
			children: ReactNode
		} & Omit<ComponentPropsWithoutRef<'a'>, 'href'>
	>
	sortableId: UniqueIdentifier
	droppableId: UniqueIdentifier
	isFiltering: boolean
	isCollapsed: boolean
	toggleCollapse: () => void
	getName: (id: string) => string
	getMeta: (id: string) => RowMeta
	getItemSortableId: (id: string) => UniqueIdentifier
	dh: RowDensity
	locked: boolean
}

export const GroupCard = memo(function GroupCard(props: Props) {
	const {
		g,
		visibleIds,
		runningSet,
		availableSet,
		desiredRunningSet,
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
			className="plx-pluginCatalog__group"
			style={{
				transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
				transition: transition ?? 'opacity 120ms ease-out',
				minWidth: 0,
				padding: 0,
			}}
			role="group"
			aria-label={`分组 ${g.name || '未命名'}`}
		>
			<Flex align="center" gap={2} justify="space-between" style={{ minWidth: 0 }}>
				<Group gap={4} align="center" wrap="nowrap" style={{ minWidth: 0, flex: 1 }}>
					<Box style={{ minWidth: 0, flex: 1 }}>
						<CatalogTooltip label={g.name || '未命名分组'} withinPortal withArrow>
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
						</CatalogTooltip>
					</Box>
					<CatalogTooltip
						label={`运行中 ${stat.running} / 共 ${stat.total} 个插件`}
						withinPortal
						withArrow
					>
						<Text
							component="span"
							size="xs"
							c="dimmed"
							style={{ flexShrink: 0 }}
							aria-label={`运行中 ${stat.running} / 共 ${stat.total} 个插件`}
						>
							{stat.total}
						</Text>
					</CatalogTooltip>
				</Group>

				<Group gap={2} align="center" wrap="nowrap" style={{ flexShrink: 0 }}>
					<CatalogTooltip label={collapseLabel} withinPortal withArrow>
						<ActionIcon
							size="xs"
							variant="subtle"
							aria-label={collapseLabel}
							onClick={toggleCollapse}
							style={{ flexShrink: 0 }}
						>
							{isCollapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
						</ActionIcon>
					</CatalogTooltip>

					<CatalogTooltip
						label={locked ? '云端同步中' : '拖拽分组'}
						withinPortal

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
					</CatalogTooltip>
				</Group>
			</Flex>

			<DroppableContainer
				id={droppableId}
				disabled={isFiltering || locked}
				minDropHeight={isCollapsed ? 10 : dh.rowH}
			>
				<Collapse expanded={!isCollapsed}>
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
									available={availableSet.has(id)}
									desiredRunning={desiredRunningSet.has(id)}
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
