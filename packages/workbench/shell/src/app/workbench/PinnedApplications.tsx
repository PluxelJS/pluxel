import {
	closestCenter,
	DndContext,
	KeyboardSensor,
	PointerSensor,
	useSensor,
	useSensors,
	type DragEndEvent,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import { ActionIcon, Button, Group, Stack, Text, Title } from '@mantine/core'
import { formatPluginNodeRoute } from '@pluxel/core'
import type { WorkbenchShortcut } from '@pluxel/workbench/client'
import { IconGripVertical } from '@tabler/icons-react'
import { useWorkbenchState } from '@worksplit/react'
import { useWorkbenchTargetSnapshot } from '../../workbench/runtime'
import { usePluginOverview } from '../plugins/pluginOverview'
import { useWorkbenchNavigation } from './context'
import { PluginConfigurationButton } from './PluginConfigurationButton'
import { SidebarPinButton } from './SidebarPinButton'
import { resolveSidebarShortcut, sidebarShortcutId } from './sidebarShortcuts'
import { useWorkspaceSession } from './workspaceContext'
import { WorkbenchEntryIcon } from './WorkbenchEntryIcon'

type ShortcutRow = {
	id: string
	shortcut: WorkbenchShortcut
	resolved: ReturnType<typeof resolveSidebarShortcut>
	pluginLabel?: string
}

export function PinnedApplications() {
	const session = useWorkspaceSession()
	const shortcuts = useWorkbenchState(session.workbench, () => session.sidebarShortcuts())
	const { layout, directory } = useWorkbenchTargetSnapshot(null)
	const { overview } = usePluginOverview()
	const pluginLabels = new Map(overview?.status.statuses.map(({ route, label }) => [route, label]))
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)
	const rows = shortcuts.map((shortcut) => ({
		id: sidebarShortcutId(shortcut),
		shortcut,
		resolved: resolveSidebarShortcut(shortcut, layout, directory),
		pluginLabel: pluginLabels.get(formatPluginNodeRoute(shortcut.target)),
	}))
	const rowIds = rows.map(({ id }) => id)
	const move = ({ active, over }: DragEndEvent) => {
		if (!over) return
		void session
			.moveSidebarShortcut(String(active.id), String(over.id))
			.catch((error: unknown) => session.report(error))
	}

	return (
		<section className="plx-apps__pinned" aria-label="已固定到侧栏">
			<Title order={2} size="h4">
				已固定到侧栏
			</Title>
			<div className="plx-apps__pinned-scroll">
				{rows.length === 0 ? (
					<Text size="sm" c="dimmed">
						点击应用名称前的图钉，将应用固定到侧栏。
					</Text>
				) : (
					<DndContext
						sensors={sensors}
						collisionDetection={closestCenter}
						modifiers={[restrictToVerticalAxis]}
						onDragEnd={move}
						accessibility={{
							screenReaderInstructions: {
								draggable: '按空格键提起或放下，用上下方向键移动，按 Esc 取消。',
							},
							announcements: {
								onDragStart: ({ active }) =>
									`开始排序 ${rows.find((row) => row.id === active.id)?.resolved.label ?? ''}`,
								onDragOver: ({ over }) =>
									over ? `移至第 ${rowIds.indexOf(String(over.id)) + 1} 项` : undefined,
								onDragEnd: ({ over }) =>
									over ? `已放在第 ${rowIds.indexOf(String(over.id)) + 1} 项` : '已取消排序',
								onDragCancel: () => '已取消排序',
							},
						}}
					>
						<SortableContext items={rowIds} strategy={verticalListSortingStrategy}>
							<Stack role="list" aria-label="已固定的应用" gap={0}>
								{rows.map((row) => (
									<SortableShortcut
										key={row.id}
										row={row}
										canReorder={rows.length > 1}
										onRemove={() =>
											void session
												.setSidebarShortcut(row.shortcut, false)
												.catch((error: unknown) => session.report(error))
										}
									/>
								))}
							</Stack>
						</SortableContext>
					</DndContext>
				)}
			</div>
		</section>
	)
}

function SortableShortcut({
	row: { id, shortcut, resolved, pluginLabel },
	canReorder,
	onRemove,
}: {
	row: ShortcutRow
	canReorder: boolean
	onRemove(): void
}) {
	const navigation = useWorkbenchNavigation()
	const {
		attributes,
		listeners,
		setNodeRef,
		setActivatorNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id, disabled: !canReorder })
	const { label, icon, href, unavailable } = resolved
	const source = [
		shortcut.target.definition.exportName,
		shortcut.target.variant === 'fork' ? shortcut.target.forkId : undefined,
		shortcut.location,
	]
		.filter(Boolean)
		.join(' · ')
	return (
		<Group
			ref={setNodeRef}
			role="listitem"
			wrap="nowrap"
			gap={2}
			bg={isDragging ? 'var(--plx-selected-bg)' : undefined}
			style={{
				position: 'relative',
				zIndex: isDragging ? 1 : undefined,
				borderRadius: 'var(--mantine-radius-sm)',
				transform: transform ? `translateY(${transform.y}px)` : undefined,
				transition,
			}}
		>
			<ActionIcon
				ref={setActivatorNodeRef}
				variant="subtle"
				color="gray"
				size="md"
				style={{
					touchAction: 'none',
					cursor: canReorder ? (isDragging ? 'grabbing' : 'grab') : undefined,
				}}
				{...attributes}
				{...listeners}
				disabled={!canReorder}
				aria-label={`排序 ${label}`}
				title={canReorder ? '拖动排序' : undefined}
			>
				<IconGripVertical size={17} aria-hidden />
			</ActionIcon>
			<SidebarPinButton label={label} pinned onToggle={onRemove} />
			{pluginLabel && <PluginConfigurationButton owner={shortcut.target} label={pluginLabel} />}
			<Button
				variant="subtle"
				justify="start"
				className="plx-apps__pinned-link"
				aria-label={label}
				aria-disabled={!href || undefined}
				leftSection={<WorkbenchEntryIcon icon={icon} />}
				title={[label, source, unavailable].filter(Boolean).join('\n')}
				onClick={href ? () => navigation.navigate(href) : undefined}
			>
				<Text component="span" size="sm" display="block" truncate="end">
					{label}
				</Text>
				<Text component="span" size="xs" c="dimmed" display="block" truncate="end">
					{unavailable ?? source}
				</Text>
			</Button>
		</Group>
	)
}
