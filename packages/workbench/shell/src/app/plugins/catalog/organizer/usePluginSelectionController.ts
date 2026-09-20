import {
	startTransition,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type SetStateAction,
} from 'react'
import { isEditableTarget } from '../filterModel'
import type { GroupConfig } from './types'
import { arraysEqual } from './organizerModel'
import { buildContainers } from './controllerModel'

export type OrganizerRowSelectMode = 'click' | 'context' | 'toggle'

type UsePluginSelectionControllerArgs = {
	activeId: string | null
	activeIds?: string[]
	allIds: string[]
	controlledSelectedIds?: string[]
	onSelectedIdsChange?: (ids: string[]) => void
	visibleGroups: GroupConfig[]
	ungroupedDisplayOrder: string[]
	onMoveSelection: () => void
	onMoveToUngrouped: () => void
	locked: boolean
}

export function usePluginSelectionController({
	activeId,
	activeIds,
	allIds,
	controlledSelectedIds,
	onSelectedIdsChange,
	visibleGroups,
	ungroupedDisplayOrder,
	onMoveSelection,
	onMoveToUngrouped,
	locked,
}: UsePluginSelectionControllerArgs) {
	const containerRef = useRef<HTMLDivElement | null>(null)
	const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>([])
	const [focusedId, setFocusedId] = useState<string | null>(activeId)
	const lastSelectedRef = useRef<string | null>(null)

	const selectedIds = controlledSelectedIds ?? internalSelectedIds
	const setSelectedIds = useCallback(
		(next: SetStateAction<string[]>) => {
			if (controlledSelectedIds === undefined) {
				setInternalSelectedIds((prev) => {
					const resolved =
						typeof next === 'function' ? (next as (value: string[]) => string[])(prev) : next
					if (arraysEqual(resolved, prev)) return prev
					onSelectedIdsChange?.(resolved)
					return resolved
				})
				return
			}

			const resolved =
				typeof next === 'function'
					? (next as (value: string[]) => string[])(controlledSelectedIds)
					: next
			if (arraysEqual(resolved, controlledSelectedIds)) return
			onSelectedIdsChange?.(resolved)
		},
		[controlledSelectedIds, onSelectedIdsChange],
	)

	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
	const activeSet = useMemo(() => {
		if (activeId) return new Set([activeId])
		if (activeIds?.length) return new Set(activeIds)
		return new Set<string>()
	}, [activeId, activeIds])

	const visibleLinearIds = useMemo(() => {
		const next = [...ungroupedDisplayOrder]
		for (const group of visibleGroups) next.push(...group.pluginIds)
		return next
	}, [ungroupedDisplayOrder, visibleGroups])

	const selectionContainers = useMemo(
		() => buildContainers(visibleGroups, ungroupedDisplayOrder),
		[ungroupedDisplayOrder, visibleGroups],
	)

	useEffect(() => {
		if (!activeId) return
		setFocusedId(activeId)
	}, [activeId])

	useEffect(() => {
		setSelectedIds((current) => current.filter((id) => allIds.includes(id)))
	}, [allIds, setSelectedIds])

	useEffect(() => {
		if (visibleLinearIds.length === 0) {
			setFocusedId(null)
			return
		}
		if (focusedId && visibleLinearIds.includes(focusedId)) return
		const nextFocus =
			activeId && visibleLinearIds.includes(activeId)
				? activeId
				: (selectedIds.find((id) => visibleLinearIds.includes(id)) ?? visibleLinearIds[0])
		setFocusedId(nextFocus)
	}, [activeId, focusedId, selectedIds, visibleLinearIds])

	useEffect(() => {
		if (!focusedId || !containerRef.current) return
		const row = Array.from(containerRef.current.querySelectorAll('[data-plugin-row="true"]')).find(
			(node) => node instanceof HTMLElement && node.dataset.pluginId === focusedId,
		)
		if (row instanceof HTMLElement) {
			row.scrollIntoView({ block: 'nearest' })
		}
	}, [focusedId])

	const activateFocusedPlugin = useCallback((pluginId: string) => {
		const rows = containerRef.current
			? Array.from(containerRef.current.querySelectorAll('[data-plugin-row="true"]'))
			: []
		for (const row of rows) {
			if (!(row instanceof HTMLElement) || row.dataset.pluginId !== pluginId) continue
			const link = row.querySelector('[data-plugin-link]')
			if (link instanceof HTMLElement) link.click()
			return
		}
	}, [])

	const handleRowSelect = useCallback(
		(event: React.MouseEvent, pluginId: string, mode: OrganizerRowSelectMode = 'click') => {
			startTransition(() => {
				setSelectedIds((prev) => {
					const itemContainer = selectionContainers.itemToContainer.get(pluginId)
					const toggle = event.ctrlKey || event.metaKey
					const range = event.shiftKey && lastSelectedRef.current
					let next = prev

					if (mode === 'toggle') {
						next = prev.includes(pluginId)
							? prev.filter((id) => id !== pluginId)
							: [...prev, pluginId]
					} else if (range && itemContainer) {
						const anchor = lastSelectedRef.current!
						const anchorContainer = selectionContainers.itemToContainer.get(anchor)
						if (anchorContainer && anchorContainer === itemContainer) {
							const list = selectionContainers.containerToItems.get(itemContainer) ?? []
							const currentIndex = list.indexOf(pluginId)
							const anchorIndex = list.indexOf(anchor)
							if (currentIndex !== -1 && anchorIndex !== -1) {
								const [lo, hi] =
									currentIndex < anchorIndex
										? [currentIndex, anchorIndex]
										: [anchorIndex, currentIndex]
								const slice = list.slice(lo, hi + 1)
								next = toggle ? Array.from(new Set([...prev, ...slice])) : slice
							} else {
								next = [pluginId]
							}
						} else {
							next = [pluginId]
						}
					} else if (toggle) {
						next = prev.includes(pluginId)
							? prev.filter((id) => id !== pluginId)
							: [...prev, pluginId]
					} else if (mode === 'context') {
						next = prev.includes(pluginId) ? prev : [pluginId]
					} else {
						next = [pluginId]
					}

					setFocusedId(pluginId)
					lastSelectedRef.current = next.includes(pluginId) ? pluginId : lastSelectedRef.current
					return next
				})
			})
		},
		[selectionContainers, setSelectedIds],
	)

	const handleBackgroundClick = useCallback(
		(event: React.MouseEvent) => {
			const target = event.target as HTMLElement | null
			if (target?.closest('[data-plugin-row]')) return
			setSelectedIds([])
			lastSelectedRef.current = null
		},
		[setSelectedIds],
	)

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			if (isEditableTarget(event.target)) return
			if (visibleLinearIds.length === 0) return

			const mod = event.metaKey || event.ctrlKey
			const moveFocus = (nextIndex: number, extendRange: boolean) => {
				const clamped = Math.max(0, Math.min(nextIndex, visibleLinearIds.length - 1))
				const nextId = visibleLinearIds[clamped]
				if (!nextId) return
				setFocusedId(nextId)
				setSelectedIds((prev) => {
					if (!extendRange) {
						lastSelectedRef.current = nextId
						return [nextId]
					}
					const anchor =
						lastSelectedRef.current && visibleLinearIds.includes(lastSelectedRef.current)
							? lastSelectedRef.current
							: (prev.find((id) => visibleLinearIds.includes(id)) ?? nextId)
					const anchorIndex = visibleLinearIds.indexOf(anchor)
					const [lo, hi] = anchorIndex < clamped ? [anchorIndex, clamped] : [clamped, anchorIndex]
					return visibleLinearIds.slice(lo, hi + 1)
				})
			}

			switch (event.key) {
				case 'a':
				case 'A': {
					if (mod) {
						event.preventDefault()
						setSelectedIds(visibleLinearIds)
						setFocusedId((current) => current ?? visibleLinearIds[0] ?? null)
						lastSelectedRef.current = visibleLinearIds[0] ?? null
					}
					break
				}
				case 'Escape':
					event.preventDefault()
					setSelectedIds([])
					lastSelectedRef.current = null
					break
				case 'ArrowDown':
					event.preventDefault()
					moveFocus((focusedId ? visibleLinearIds.indexOf(focusedId) : -1) + 1, event.shiftKey)
					break
				case 'ArrowUp':
					event.preventDefault()
					moveFocus(
						focusedId ? visibleLinearIds.indexOf(focusedId) - 1 : visibleLinearIds.length - 1,
						event.shiftKey,
					)
					break
				case 'Home':
					event.preventDefault()
					moveFocus(0, event.shiftKey)
					break
				case 'End':
					event.preventDefault()
					moveFocus(visibleLinearIds.length - 1, event.shiftKey)
					break
				case ' ': {
					event.preventDefault()
					const targetId = focusedId ?? visibleLinearIds[0]
					if (!targetId) return
					setSelectedIds((prev) => {
						if (mod) {
							const next = prev.includes(targetId)
								? prev.filter((id) => id !== targetId)
								: [...prev, targetId]
							lastSelectedRef.current = targetId
							return next
						}
						lastSelectedRef.current = targetId
						return prev.length === 1 && prev[0] === targetId ? [] : [targetId]
					})
					break
				}
				case 'Enter':
					event.preventDefault()
					if (focusedId) activateFocusedPlugin(focusedId)
					break
				case 'm':
				case 'M': {
					if (!(mod || event.altKey || locked || selectedIds.length === 0)) {
						event.preventDefault()
						onMoveSelection()
					}
					break
				}
				case 'u':
				case 'U': {
					if (!(mod || event.altKey || locked || selectedIds.length === 0)) {
						event.preventDefault()
						onMoveToUngrouped()
					}
					break
				}
				default:
					break
			}
		},
		[
			activateFocusedPlugin,
			focusedId,
			locked,
			onMoveSelection,
			onMoveToUngrouped,
			selectedIds.length,
			setSelectedIds,
			visibleLinearIds,
		],
	)

	const selectOnly = useCallback(
		(pluginId: string) => {
			setSelectedIds([pluginId])
			setFocusedId(pluginId)
			lastSelectedRef.current = pluginId
		},
		[setSelectedIds],
	)

	return {
		activeSet,
		containerRef,
		focusedId,
		handleBackgroundClick,
		handleKeyDown,
		handleRowSelect,
		lastSelectedRef,
		selectOnly,
		selectedIds,
		selectedSet,
		setFocusedId,
		setSelectedIds,
	}
}
