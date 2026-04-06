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
import { startTransition, useCallback, useEffect, useMemo, useState } from 'react'
import type { Dispatch, MutableRefObject, SetStateAction } from 'react'
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
			const movingIds =
				selectedIds.length > 1 && selectedIds.includes(draggingPluginId)
					? selectedIds
					: [draggingPluginId]
			const movingSet = new Set(movingIds)
			const originContainer = containers.itemToContainer.get(draggingPluginId)
			if (!originContainer) return

			const orderedMoving = (containers.containerToItems.get(originContainer) ?? []).filter((id) =>
				movingSet.has(id),
			)

			const targetContainer = isCid(overId)
				? fromCid(String(overId))
				: isIid(overId)
					? (containers.itemToContainer.get(fromIid(String(overId))) ?? 'ROOT_UNGROUPED')
					: undefined
			if (!targetContainer) return

			if (originContainer === targetContainer) {
				const full = containers.containerToItems.get(originContainer) ?? []
				const targetId = isIid(overId) ? fromIid(String(overId)) : undefined
				const selfBehavior: 'before' | 'after' | undefined =
					targetId && movingSet.has(targetId)
						? (delta?.y ?? 0) < 0
							? 'before'
							: 'after'
						: undefined
				const targetIndex = computeTargetIndex(full, movingSet, targetId, { selfBehavior })
				const nextList = insertKeepOrder(full, movingSet, orderedMoving, targetIndex)

				if (originContainer === 'ROOT_UNGROUPED') {
					setUngroupedOrder(nextList)
				} else {
					setGroups((prev) =>
						prev.map((group) =>
							group.groupId === originContainer ? { ...group, pluginIds: nextList } : group,
						),
					)
				}

				queueMicrotask(() => {
					assertNoDup(groupsRef.current, ungroupedRef.current)
					onGroupsChangeRef.current(groupsRef.current)
				})
				return
			}

			const originItems = containers.containerToItems.get(originContainer) ?? []
			const targetItems = containers.containerToItems.get(targetContainer) ?? []
			const targetId = isIid(overId) ? fromIid(String(overId)) : undefined
			const targetIndex = computeTargetIndex(targetItems, movingSet, targetId)

			if (originContainer === 'ROOT_UNGROUPED') {
				setUngroupedOrder(originItems.filter((id) => !movingSet.has(id)))
			} else {
				setGroups((prev) =>
					prev.map((group) =>
						group.groupId === originContainer
							? { ...group, pluginIds: group.pluginIds.filter((id) => !movingSet.has(id)) }
							: group,
					),
				)
			}

			if (targetContainer === 'ROOT_UNGROUPED') {
				setUngroupedOrder((prev) => insertKeepOrder(prev, movingSet, movingIds, targetIndex))
			} else {
				setGroups((prev) =>
					prev.map((group) =>
						group.groupId === targetContainer
							? {
									...group,
									pluginIds: insertKeepOrder(group.pluginIds, movingSet, movingIds, targetIndex),
								}
							: group,
					),
				)
			}

			queueMicrotask(() => {
				assertNoDup(groupsRef.current, ungroupedRef.current)
				onGroupsChangeRef.current(groupsRef.current)
			})
		},
		[
			groupsRef,
			onGroupsChangeRef,
			selectedIds,
			selectOnly,
			selectedSet,
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
