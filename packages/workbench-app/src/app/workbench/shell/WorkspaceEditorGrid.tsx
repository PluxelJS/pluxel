import {
	DndContext,
	DragOverlay,
	KeyboardSensor,
	PointerSensor,
	closestCenter,
	pointerWithin,
	useDraggable,
	useDroppable,
	useSensor,
	useSensors,
	type CollisionDetection,
	type DragEndEvent,
	type DragStartEvent,
} from '@dnd-kit/core'
import { useStore } from '@tanstack/react-store'
import { IconGripVertical, IconPlus, IconX } from '@tabler/icons-react'
import {
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type CSSProperties,
	type KeyboardEvent,
	type MouseEvent,
	type ReactNode,
} from 'react'
import { PluginWorkbenchLayoutProvider } from '../../plugins/detail/workbench/context'
import {
	WorkbenchDocumentScope,
	WorkbenchNavigationProvider,
	useWorkspaceController,
} from '../context'
import type { WorkbenchEditorGroupState, WorkbenchTab } from '../state'
import {
	WorkbenchEditorGrid,
	type EditorGridDirection,
	type EditorGridHandle,
	type EditorGridGroup,
} from '../split'
import { WorkbenchDocumentRenderer } from './WorkbenchDocumentRenderer'

type TabDragData = {
	kind: 'tab'
	groupId: string
	tabId: string
	index: number
}

type GroupDropData = {
	kind: 'group-drop'
	groupId: string
	position: EditorGridDirection | 'center'
}

type DropData = TabDragData | GroupDropData

const editorCollisionDetection: CollisionDetection = (args) => {
	const pointerCollisions = pointerWithin(args)
	return pointerCollisions.length > 0 ? pointerCollisions : closestCenter(args)
}

export function WorkspaceEditorGrid({
	isNarrowViewport,
	navigate,
	pathname,
}: {
	isNarrowViewport: boolean
	navigate: (path: string) => void
	pathname: string
}) {
	const workspace = useWorkspaceController()
	const tabs = useStore(workspace.store, (state) => state.uiState.tabs)
	const editor = useStore(workspace.store, (state) => state.uiState.editor)
	const dirtyTabs = useStore(workspace.store, (state) => state.dirtyTabs)
	const gridRef = useRef<EditorGridHandle | null>(null)
	const pendingGroupMoveRef = useRef<{
		groupId: string
		targetGroupId: string
		position: EditorGridDirection
	} | null>(null)
	const [draggedTabId, setDraggedTabId] = useState<string | null>(null)
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
		useSensor(KeyboardSensor),
	)
	const tabById = useMemo(() => new Map(tabs.map((tab) => [tab.instanceId, tab])), [tabs])

	const navigateToActiveTab = useCallback(() => {
		const activeTab = workspace.activeTab
		if (activeTab && activeTab.path !== pathname) navigate(activeTab.path)
	}, [navigate, pathname, workspace])

	const focusGroup = useCallback(
		(groupId: string, reason: 'action' | 'content' | 'tab') => {
			const tab = workspace.focusGroup(groupId)
			if (reason !== 'action' && tab && tab.path !== pathname) navigate(tab.path)
		},
		[navigate, pathname, workspace],
	)

	useEffect(() => {
		const pending = pendingGroupMoveRef.current
		if (!pending || !editor.groups.some((group) => group.id === pending.groupId)) return
		pendingGroupMoveRef.current = null
		gridRef.current?.moveGroup(pending)
	}, [editor.groups])

	useEffect(() => {
		if (!isNarrowViewport) {
			gridRef.current?.restore()
			return
		}
		if (editor.activeGroupId) gridRef.current?.maximize(editor.activeGroupId)
	}, [editor.activeGroupId, isNarrowViewport])

	const closeTab = useCallback(
		(tabId: string) => {
			if (dirtyTabs[tabId]) {
				const tab = tabById.get(tabId)
				const confirmed = window.confirm(
					`"${tab?.title ?? '当前标签页'}" 还有未保存更改，确定关闭吗？`,
				)
				if (!confirmed) return
			}
			workspace.closeTab(tabId)
			navigateToActiveTab()
		},
		[dirtyTabs, navigateToActiveTab, tabById, workspace],
	)

	const createAdjacentTab = useCallback(
		(groupId: string) => {
			workspace.createAdjacentTab(groupId)
			navigateToActiveTab()
		},
		[navigateToActiveTab, workspace],
	)

	const handleDragStart = useCallback((event: DragStartEvent) => {
		const data = event.active.data.current as DropData | undefined
		setDraggedTabId(data?.kind === 'tab' ? data.tabId : null)
	}, [])

	const handleDragEnd = useCallback(
		(event: DragEndEvent) => {
			setDraggedTabId(null)
			const activeData = event.active.data.current as DropData | undefined
			const overData = event.over?.data.current as DropData | undefined
			if (!activeData || activeData.kind !== 'tab' || !overData) return

			if (overData.kind === 'tab') {
				workspace.moveTab({
					tabId: activeData.tabId,
					targetGroupId: overData.groupId,
					targetIndex: overData.index,
				})
				navigateToActiveTab()
				return
			}

			if (overData.position === 'center') {
				const targetGroup = workspace.state.uiState.editor.groups.find(
					(group) => group.id === overData.groupId,
				)
				if (!targetGroup) return
				workspace.moveTab({
					tabId: activeData.tabId,
					targetGroupId: targetGroup.id,
					targetIndex: targetGroup.tabIds.length,
				})
				navigateToActiveTab()
				return
			}

			const sourceGroup = workspace.state.uiState.editor.groups.find((group) =>
				group.tabIds.includes(activeData.tabId),
			)
			if (!sourceGroup) return
			let movedGroupId = sourceGroup.id
			if (sourceGroup.tabIds.length > 1) {
				const createdGroupId = workspace.splitTab(activeData.tabId)
				if (!createdGroupId) return
				movedGroupId = createdGroupId
			}
			if (movedGroupId === overData.groupId) return
			pendingGroupMoveRef.current = {
				groupId: movedGroupId,
				targetGroupId: overData.groupId,
				position: overData.position,
			}
			if (movedGroupId === sourceGroup.id) {
				gridRef.current?.moveGroup(pendingGroupMoveRef.current)
				pendingGroupMoveRef.current = null
				workspace.focusGroup(movedGroupId)
			}
			navigateToActiveTab()
		},
		[navigateToActiveTab, workspace],
	)

	const gridGroups = useMemo<EditorGridGroup[]>(
		() =>
			editor.groups.flatMap((group) => {
				const groupTabs = group.tabIds.flatMap((tabId) => {
					const tab = tabById.get(tabId)
					if (!tab) return []
					return [
						{
							id: tab.instanceId,
							title: tab.title,
							renderLabel: (active: boolean) => (
								<DraggableTabLabel
									active={active}
									dirty={Boolean(dirtyTabs[tab.instanceId])}
									group={group}
									onAdd={() => createAdjacentTab(group.id)}
									onClose={() => closeTab(tab.instanceId)}
									tab={tab}
								/>
							),
							renderContent: () => (
								<EditorGroupDocument
									dragging={draggedTabId !== null}
									groupId={group.id}
									navigate={navigate}
									tab={tab}
									workspace={workspace}
								/>
							),
						},
					]
				})
				if (groupTabs.length === 0) return []
				return [{ id: group.id, activeTabId: group.activeTabId, tabs: groupTabs }]
			}),
		[
			closeTab,
			createAdjacentTab,
			dirtyTabs,
			draggedTabId,
			editor.groups,
			navigate,
			tabById,
			workspace,
		],
	)

	const draggedTab = draggedTabId ? tabById.get(draggedTabId) : undefined
	return (
		<DndContext
			collisionDetection={editorCollisionDetection}
			onDragCancel={() => setDraggedTabId(null)}
			onDragEnd={handleDragEnd}
			onDragStart={handleDragStart}
			sensors={sensors}
		>
			<WorkbenchEditorGrid
				groups={gridGroups}
				layout={editor.layout}
				onActiveTabsChange={(activeTabs) => {
					workspace.setActiveTabs(activeTabs)
					navigateToActiveTab()
				}}
				onFocusGroup={focusGroup}
				onLayoutCommit={(layout) => workspace.setEditorLayout(layout)}
				ref={gridRef}
			/>
			<DragOverlay dropAnimation={null}>
				{draggedTab ? (
					<div className="plx-workbench__editorTabDragOverlay">
						<IconGripVertical size={13} />
						<span>{draggedTab.title}</span>
					</div>
				) : null}
			</DragOverlay>
		</DndContext>
	)
}

function DraggableTabLabel({
	active,
	dirty,
	group,
	onAdd,
	onClose,
	tab,
}: {
	active: boolean
	dirty: boolean
	group: WorkbenchEditorGroupState
	onAdd: () => void
	onClose: () => void
	tab: WorkbenchTab
}) {
	const index = group.tabIds.indexOf(tab.instanceId)
	const dragData = useMemo<TabDragData>(
		() => ({ kind: 'tab', groupId: group.id, tabId: tab.instanceId, index }),
		[group.id, index, tab.instanceId],
	)
	const draggable = useDraggable({ id: `editor-tab-drag:${tab.instanceId}`, data: dragData })
	const droppable = useDroppable({ id: `editor-tab-drop:${tab.instanceId}`, data: dragData })
	const setNodeRef = useCallback(
		(node: HTMLElement | null) => {
			draggable.setNodeRef(node)
			droppable.setNodeRef(node)
		},
		[draggable, droppable],
	)
	const style: CSSProperties | undefined = draggable.transform
		? {
				transform: `translate3d(${draggable.transform.x}px, ${draggable.transform.y}px, 0)`,
				zIndex: 20,
			}
		: undefined

	return (
		<span
			className="plx-workbench__editorTabLabel"
			data-dragging={draggable.isDragging ? 'true' : 'false'}
			data-drop-target={droppable.isOver ? 'true' : 'false'}
			ref={setNodeRef}
			style={style}
		>
			<span
				className="plx-workbench__editorTabDragHandle"
				title="拖拽排序，或放到编辑区边缘进行拆分"
				{...draggable.attributes}
				{...draggable.listeners}
			>
				<IconGripVertical aria-hidden="true" size={13} stroke={1.7} />
				<span className="plx-workbench__editorTabBody">
					<span className="plx-workbench__editorTabTitle">{tab.title}</span>
					{tab.meta ? <span className="plx-workbench__editorTabMeta">{tab.meta}</span> : null}
				</span>
			</span>
			{dirty ? (
				<span className="plx-workbench__editorTabDirtyDot" title="未保存更改" aria-hidden="true" />
			) : null}
			<TabLabelAction active={active} label={`关闭 ${tab.title}`} onAction={onClose}>
				<IconX size={14} stroke={1.8} />
			</TabLabelAction>
			{active ? (
				<TabLabelAction active label="在当前编辑组新增工作标签" onAction={onAdd}>
					<IconPlus size={14} stroke={1.9} />
				</TabLabelAction>
			) : null}
		</span>
	)
}

function TabLabelAction({
	active,
	children,
	label,
	onAction,
}: {
	active: boolean
	children: ReactNode
	label: string
	onAction: () => void
}) {
	const activate = (event: MouseEvent | KeyboardEvent) => {
		event.preventDefault()
		event.stopPropagation()
		onAction()
	}
	return (
		<span
			aria-label={label}
			className="plx-workbench__editorTabAction"
			onClick={activate}
			onKeyDown={(event) => {
				if (event.key === 'Enter' || event.key === ' ') activate(event)
			}}
			role="button"
			tabIndex={active ? 0 : -1}
			title={label}
		>
			{children}
		</span>
	)
}

function EditorGroupDocument({
	dragging,
	groupId,
	navigate,
	tab,
	workspace,
}: {
	dragging: boolean
	groupId: string
	navigate: (path: string) => void
	tab: WorkbenchTab
	workspace: ReturnType<typeof useWorkspaceController>
}) {
	const navigation = useMemo(
		() => ({
			navigate: (path: string) => {
				workspace.requestNavigation(path, groupId)
				navigate(path)
			},
			openTab: (input: { path: string; title: string; meta?: string }) => {
				workspace.openTab(input, groupId)
				navigate(input.path)
			},
		}),
		[groupId, navigate, workspace],
	)
	return (
		<WorkbenchDocumentScope pathname={tab.path} tabId={tab.instanceId}>
			<WorkbenchNavigationProvider value={navigation}>
				<PluginWorkbenchLayoutProvider>
					<div className="plx-workbench__workspace">
						<div className="plx-workbench__workspaceContent">
							<WorkbenchDocumentRenderer pathname={tab.path} />
						</div>
						<div
							aria-hidden={dragging ? undefined : true}
							className="plx-workbench__editorDropZones"
							data-visible={dragging ? 'true' : 'false'}
						>
							<EditorDropZone groupId={groupId} position="top" label="拆分到上方" />
							<EditorDropZone groupId={groupId} position="left" label="拆分到左侧" />
							<EditorDropZone groupId={groupId} position="center" label="移到此编辑组" />
							<EditorDropZone groupId={groupId} position="right" label="拆分到右侧" />
							<EditorDropZone groupId={groupId} position="bottom" label="拆分到下方" />
						</div>
					</div>
				</PluginWorkbenchLayoutProvider>
			</WorkbenchNavigationProvider>
		</WorkbenchDocumentScope>
	)
}

function EditorDropZone({
	groupId,
	label,
	position,
}: {
	groupId: string
	label: string
	position: GroupDropData['position']
}) {
	const data = useMemo<GroupDropData>(
		() => ({ kind: 'group-drop', groupId, position }),
		[groupId, position],
	)
	const { isOver, setNodeRef } = useDroppable({
		id: `editor-group-drop:${groupId}:${position}`,
		data,
	})
	return (
		<div
			className="plx-workbench__editorDropZone"
			data-over={isOver ? 'true' : 'false'}
			data-position={position}
			ref={setNodeRef}
		>
			<span>{label}</span>
		</div>
	)
}
