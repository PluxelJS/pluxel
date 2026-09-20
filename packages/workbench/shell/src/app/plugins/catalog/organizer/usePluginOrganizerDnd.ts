import {
	type DragEndEvent,
	type DragStartEvent,
	KeyboardSensor,
	type UniqueIdentifier,
	PointerSensor,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { arrayMove, sortableKeyboardCoordinates } from '@dnd-kit/sortable'
import {
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useState,
	type Dispatch,
	type MutableRefObject,
	type SetStateAction,
} from 'react'
import { sortPluginIdsByOrder } from './groupOperations'
import { assertNoDup } from './organizerModel'
import {
	buildContainers,
	fromCid,
	fromGid,
	fromIid,
	gid,
	isCid,
	isGid,
	isIid,
} from './controllerModel'
import type { GroupConfig } from './types'

type UsePluginOrganizerDndArgs = {
	groups: GroupConfig[]
	expandFamilies: (ids: string[]) => string[]
	groupsRef: MutableRefObject<GroupConfig[]>
	ungroupedRef: MutableRefObject<string[]>
	selectedIds: string[]
	selectedSet: Set<string>
	selectOnly: (pluginId: string) => void
	setGroups: Dispatch<SetStateAction<GroupConfig[]>>
	setUngroupedOrder: Dispatch<SetStateAction<string[]>>
	onGroupsChangeRef: MutableRefObject<(groups: GroupConfig[]) => void>
}

const insertKeepOrder = (
	base: string[],
	moving: Set<string>,
	orderedMoving: string[],
	at: number,
) => {
	const filtered = base.filter((id) => !moving.has(id))
	const nextIndex = Math.max(0, Math.min(at, filtered.length))
	return [...filtered.slice(0, nextIndex), ...orderedMoving, ...filtered.slice(nextIndex)]
}

const computeTargetIndex = (
	full: string[],
	movingSet: Set<string>,
	overId?: string,
	opts?: { selfBehavior?: 'before' | 'after' },
): number => {
	const filtered = full.filter((id) => !movingSet.has(id))
	if (!overId) return filtered.length

	if (movingSet.has(overId)) {
		const behavior = opts?.selfBehavior ?? 'after'
		let first = Number.POSITIVE_INFINITY
		let last = -1
		for (let index = 0; index < full.length; index += 1) {
			if (!movingSet.has(full[index])) continue
			first = Math.min(first, index)
			last = Math.max(last, index)
		}

		if (behavior === 'after') {
			const next = full.slice(last + 1).find((id) => !movingSet.has(id))
			return next ? Math.max(0, filtered.indexOf(next) + 1) : filtered.length
		}

		const prev = full
			.slice(0, Math.max(0, first))
			.toReversed()
			.find((id) => !movingSet.has(id))
		return prev ? Math.max(0, filtered.indexOf(prev)) : 0
	}

	return Math.max(0, filtered.indexOf(overId))
}

export function usePluginOrganizerDnd({
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
}: UsePluginOrganizerDndArgs) {
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)

	const [dragActiveId, setDragActiveId] = useState<UniqueIdentifier | null>(null)
	const groupIdsSortable = useMemo(() => groups.map((group) => gid(group.groupId)), [groups])

	useEffect(() => {
		return () => {
			document.body.style.userSelect = ''
		}
	}, [])

	const handleDragStart = useCallback(
		({ active }: DragStartEvent) => {
			setDragActiveId(active.id)
			if (isIid(active.id)) {
				const pluginId = fromIid(String(active.id))
				if (!selectedSet.has(pluginId)) {
					startTransition(() => selectOnly(pluginId))
				}
			}
			document.body.style.userSelect = 'none'
		},
		[selectedSet, selectOnly],
	)

	const handleDragEnd = useCallback(
		({ active, over, delta }: DragEndEvent) => {
			document.body.style.userSelect = ''
			setDragActiveId(null)

			const activeId = active?.id as UniqueIdentifier
			const overId = over?.id as UniqueIdentifier | undefined
			if (!overId) return

			const containers = buildContainers(groupsRef.current, ungroupedRef.current)

			if (isGid(activeId) && isGid(overId)) {
				const movingGroupId = fromGid(String(activeId))
				const targetGroupId = fromGid(String(overId))
				const groupOrder = groupsRef.current.map((group) => group.groupId)
				const oldIndex = groupOrder.indexOf(movingGroupId)
				const newIndex = groupOrder.indexOf(targetGroupId)
				if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return
				const nextGroups = arrayMove(groupsRef.current, oldIndex, newIndex)
				setGroups(nextGroups)
				queueMicrotask(() => onGroupsChangeRef.current(nextGroups))
				return
			}

			if (!isIid(activeId)) return

			const draggingPluginId = fromIid(String(activeId))
			const movingIds = sortPluginIdsByOrder(
				expandFamilies(selectedIds.includes(draggingPluginId) ? selectedIds : [draggingPluginId]),
				groupsRef.current,
				ungroupedRef.current,
			)
			const movingSet = new Set(movingIds)
			const originContainer = containers.itemToContainer.get(draggingPluginId)
			if (!originContainer) return

			const targetContainer = isCid(overId)
				? fromCid(String(overId))
				: isIid(overId)
					? (containers.itemToContainer.get(fromIid(String(overId))) ?? 'ROOT_UNGROUPED')
					: undefined
			if (!targetContainer) return

			const targetItems = containers.containerToItems.get(targetContainer) ?? []
			const targetId = isIid(overId) ? fromIid(String(overId)) : undefined
			const targetIndex = computeTargetIndex(targetItems, movingSet, targetId, {
				selfBehavior: (delta?.y ?? 0) < 0 ? 'before' : 'after',
			})
			const nextGroups = groupsRef.current.map((group) => ({
				...group,
				pluginIds:
					group.groupId === targetContainer
						? insertKeepOrder(group.pluginIds, movingSet, movingIds, targetIndex)
						: group.pluginIds.filter((id) => !movingSet.has(id)),
			}))
			const nextUngrouped =
				targetContainer === 'ROOT_UNGROUPED'
					? insertKeepOrder(ungroupedRef.current, movingSet, movingIds, targetIndex)
					: ungroupedRef.current.filter((id) => !movingSet.has(id))
			assertNoDup(nextGroups, nextUngrouped)
			groupsRef.current = nextGroups
			ungroupedRef.current = nextUngrouped
			setGroups(nextGroups)
			setUngroupedOrder(nextUngrouped)
			queueMicrotask(() => onGroupsChangeRef.current(nextGroups))
		},
		[
			expandFamilies,
			groupsRef,
			onGroupsChangeRef,
			selectedIds,
			setGroups,
			setUngroupedOrder,
			ungroupedRef,
		],
	)

	return {
		dragActiveId,
		groupIdsSortable,
		handleDragEnd,
		handleDragStart,
		sensors,
	}
}
