// src/components/PluginOrganizer.tsx
/**
 * PluginOrganizer
 * -----------------------------------------------------------------------------
 * 设计目标
 * 1) 布局：上（未分组）与下（我的分组）弹性分配
 *    - 无分组时：未分组尽可能占满竖向空间；我的分组仅展示提示
 *    - 有分组时：未分组:我的分组 ≈ 1:2 分配空间，二者各自可滚动
 *
 * 2) 状态流转（本地优先）
 *    - 仅在首次挂载时读取 external initialGroups；之后完全本地化
 *    - 外部变更仅通过 onGroupsChange 单向“提交”出去；提交位置统一在微任务队列
 *    - 当插件全集（statuses 的 keys）变化时：清洗组内/未分组的无效 ID；新 ID 默认进入未分组尾部
 *
 * 3) 搜索（混合搜索）
 *    - 输入字符串在前端本地低延迟匹配
 *    - 命中规则：组名包含 q || 组内任意插件(名称/ID)包含 q
 *      命中组名时：不裁剪该组插件（展示完整），只命中插件时：裁剪为命中子集
 *    - 未分组区则直接按插件维度匹配
 *
 * 4) DnD 体验 & 性能
 *    - dnd-kit：限制垂直轴、closestCorners、droppable MeasuringStrategy.Always（折叠/过滤时稳定）
 *    - 允许在空容器/折叠容器投放（minDropHeight 占位）
 *    - 支持多选块移动（右键选择；Ctrl/Cmd 多选；Shift 区间）
 *    - 拖拽结束后只触发一次外部提交，并在微任务队列中进行
 *
 * 5) 可达性与可维护性
 *    - 为列表/项/容器添加 role/aria 标注；键盘传感器可排序
 *    - 关键子项 memo 化（GroupCard / SortableRow），传入 props 最小化
 *    - 折叠状态持久化 localStorage，仅存储为 true 的折叠组 ID
 *
 * 6) 可扩展性
 *    - 预留 className/style 便于放入任意父布局（父级给到 height:100% 即可）
 *    - 可选 LinkComponent 适配路由（Wouter/React-Router 等）
 *
 * 注意
 * - 若列表超大（上千条）且需要极致性能，可接入 @tanstack/react-virtual 实现行级虚拟化；
 *   与 dnd-kit 结合需额外的测量缓存与占位策略，这里暂不内置。
 * -----------------------------------------------------------------------------
 */

import {
	closestCorners,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	type DragStartEvent,
	KeyboardSensor,
	MeasuringStrategy,
	PointerSensor,
	type UniqueIdentifier,
	useSensor,
	useSensors,
} from '@dnd-kit/core'
import { restrictToVerticalAxis } from '@dnd-kit/modifiers'
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	verticalListSortingStrategy,
} from '@dnd-kit/sortable'
import {
	ActionIcon,
	Badge,
	Box,
	Card,
	Group,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
} from '@mantine/core'
import { IconFolderPlus } from '@tabler/icons-react'
import type React from 'react'
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { parseSearchTokens } from '../shared/search'
import { DroppableContainer } from './components/DroppableContainer'
import { GroupCard } from './components/GroupCard'
import { SortableRow } from './components/SortableRow'
import { DENSITY, type Density } from './constants'
import type { GroupConfig, PluginStatuses } from './types'
import {
	arraysEqual,
	assertNoDup,
	COLLAPSE_STORAGE_KEY,
	genGroupId,
	readCollapsedState,
	sanitize,
	unique,
} from './utils'
import { deriveRootLabel } from './utils/roots'
import type { WorkbenchNavigationRequest } from '../../workbench/context'

export type { GroupConfig, PluginStatus, PluginStatuses } from './types'

export type StatusFilter = {
	running: boolean
	stopped: boolean
	disabled: boolean
}

type Props = {
	statuses: PluginStatuses
	initialGroups: GroupConfig[]
	onGroupsChange: (groups: GroupConfig[]) => void
	filterQuery?: string
	statusFilter?: StatusFilter
	LinkComponent?: React.ComponentType<
		{
			to: string
			children: React.ReactNode
			workbenchMode?: WorkbenchNavigationRequest
		} & Omit<React.ComponentPropsWithoutRef<'a'>, 'href'>
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
	style?: React.CSSProperties
}

// ---- id helpers（前缀化，避免冲突）----
const cid = (c: 'ROOT_UNGROUPED' | string) =>
	c === 'ROOT_UNGROUPED' ? 'c:ROOT' : (`c:${c}` as const)
const isCid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('c:')
const fromCid = (id: string): 'ROOT_UNGROUPED' | string =>
	id === 'c:ROOT' ? 'ROOT_UNGROUPED' : id.slice(2)

const iid = (p: string) => `i:${p}`
const isIid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('i:')
const fromIid = (id: string) => id.slice(2)

const gid = (g: string) => `g:${g}`
const isGid = (id: UniqueIdentifier) => typeof id === 'string' && id.startsWith('g:')
const fromGid = (id: string) => id.slice(2)

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
	const effectiveStatusFilter = statusFilter ?? { running: true, stopped: true, disabled: true }
	const searchTokens = useMemo(() => parseSearchTokens(filterQuery), [filterQuery])
	const hasStatusFilter =
		!effectiveStatusFilter.running ||
		!effectiveStatusFilter.stopped ||
		!effectiveStatusFilter.disabled

	// 基础映射
	const runningSet = useMemo(() => {
		const s = new Set<string>()
		for (const [id, status] of Object.entries(statuses)) if (status.isRunning) s.add(id)
		return s
	}, [statuses])
	const enabledSet = useMemo(() => {
		const s = new Set<string>()
		for (const [id, status] of Object.entries(statuses)) if (status.isEnabled !== false) s.add(id)
		return s
	}, [statuses])
	const getName = useCallback((id: string) => statuses[id]?.name ?? id, [statuses])
	const getMeta = useCallback(
		(id: string) => ({ tag: statuses[id]?.tag, version: statuses[id]?.version }),
		[statuses],
	)

	const allIds = useMemo(() => Object.keys(statuses), [statuses])
	const { groups: saneGroups, ungrouped: saneUngrouped } = useMemo(
		() => sanitize(allIds, initialGroups),
		[allIds, initialGroups],
	)

	// —— 本地优先：只在首次挂载吃初始值 —— //
	const [groups, setGroups] = useState<GroupConfig[]>(() => saneGroups)
	const [ungroupedOrder, setUngroupedOrder] = useState<string[]>(() => saneUngrouped)

	const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>([])
	const selectedIds = controlledSelectedIds ?? internalSelectedIds
	const setSelectedIds = useCallback(
		(next: React.SetStateAction<string[]>) => {
			if (controlledSelectedIds === undefined) {
				setInternalSelectedIds((prev) => {
					const resolved =
						typeof next === 'function' ? (next as (p: string[]) => string[])(prev) : next
					if (arraysEqual(resolved, prev)) return prev
					onSelectedIdsChange?.(resolved)
					return resolved
				})
				return
			}
			const base = controlledSelectedIds
			const resolved = typeof next === 'function' ? (next as (p: string[]) => string[])(base) : next
			if (arraysEqual(resolved, base)) return
			onSelectedIdsChange?.(resolved)
		},
		[controlledSelectedIds, onSelectedIdsChange],
	)
	const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds])
	const lastSelectedRef = useRef<string | null>(null)
	const [collapsed, setCollapsed] = useState<Record<string, boolean>>(() => readCollapsedState())

	// 导航态集合
	const activeSet = useMemo(() => {
		if (propActiveId) return new Set([propActiveId])
		if (activeIds?.length) return new Set(activeIds)
		return new Set<string>()
	}, [propActiveId, activeIds])
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
	const isFiltering =
		searchTokens.plain.length > 0 ||
		searchTokens.pkg.length > 0 ||
		searchTokens.tag.length > 0 ||
		searchTokens.version.length > 0 ||
		searchTokens.id.length > 0 ||
		hasStatusFilter
	const pluginMatch = useCallback(
		(id: string) => {
			const st = statuses[id]
			const name = (st?.name || '').toLowerCase()
			const pkg = (st?.packageName || '').toLowerCase()
			const tag = (st?.tag || '').toLowerCase()
			const version = (st?.version || '').toLowerCase()
			const idValue = id.toLowerCase()

			const running = !!st?.isRunning
			const enabled = st?.isEnabled !== false
			const disabled = !enabled
			const stopped = enabled && !running
			const statusOk =
				(effectiveStatusFilter.running && running) ||
				(effectiveStatusFilter.stopped && stopped) ||
				(effectiveStatusFilter.disabled && disabled)

			if (!statusOk) return false

			const plainOk = searchTokens.plain.every((term) =>
				[name, pkg, tag, version, idValue].some((field) => field.includes(term)),
			)
			const pkgOk = searchTokens.pkg.every((term) => pkg.includes(term))
			const tagOk = searchTokens.tag.every((term) => tag.includes(term))
			const versionOk = searchTokens.version.every((term) => version.includes(term))
			const idOk = searchTokens.id.every((term) => idValue.includes(term))

			return plainOk && pkgOk && tagOk && versionOk && idOk
		},
		[effectiveStatusFilter, searchTokens, statuses],
	)

	const handleBackgroundClick = useCallback(
		(e: React.MouseEvent) => {
			// 点击空白区域时清空选择；如果命中行则不清空
			const target = e.target as HTMLElement | null
			if (target?.closest('[data-plugin-row]')) return
			setSelectedIds([])
			lastSelectedRef.current = null
		},
		[setSelectedIds],
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

	const hmrUngrouped = useMemo(
		() => visibleUngrouped.filter((id) => statuses[id]?.sourceKind === 'hmr'),
		[statuses, visibleUngrouped],
	)
	const packageUngrouped = useMemo(
		() => visibleUngrouped.filter((id) => statuses[id]?.sourceKind !== 'hmr'),
		[statuses, visibleUngrouped],
	)

	const hmrVirtualGroups = useMemo(() => {
		const map = new Map<string, { label: string; pluginIds: string[] }>()
		for (const id of hmrUngrouped) {
			const st = statuses[id]
			const label = deriveRootLabel(st?.moduleId ?? null, st?.name ?? id)
			const key = label || '本地插件'
			const group = map.get(key) ?? { label: key, pluginIds: [] }
			group.pluginIds.push(id)
			map.set(key, group)
		}
		return [...map.values()]
	}, [hmrUngrouped, statuses])

	const ungroupedDisplayOrder = useMemo(() => {
		const ordered: string[] = []
		for (const group of hmrVirtualGroups) ordered.push(...group.pluginIds)
		ordered.push(...packageUngrouped)
		return ordered
	}, [hmrVirtualGroups, packageUngrouped])

	// 混合搜索：组名命中 -> 展示完整组；否则裁剪到命中插件子集
	const visibleGroups = useMemo(() => {
		if (!isFiltering) return groups
		return groups.reduce<GroupConfig[]>((acc, group) => {
			const nameMatch =
				searchTokens.plain.length > 0 &&
				searchTokens.plain.every((term) => (group.name || '').toLowerCase().includes(term))
			const pluginIds = nameMatch ? [...group.pluginIds] : group.pluginIds.filter(pluginMatch)
			if (!nameMatch && pluginIds.length === 0) return acc
			acc.push({ ...group, pluginIds })
			return acc
		}, [])
	}, [groups, isFiltering, pluginMatch, searchTokens.plain])

	// —— 容器映射（复用给 Shift 选择 & 拖放） —— //
	const buildContainers = useCallback((gs: GroupConfig[], un: string[]) => {
		const containerToItems = new Map<string, string[]>()
		containerToItems.set(
			'ROOT_UNGROUPED',
			un.filter((id) => !gs.some((g) => g.pluginIds.includes(id))),
		)
		for (const g of gs) containerToItems.set(g.groupId, [...g.pluginIds])
		const itemToContainer = new Map<string, string>()
		for (const [k, v] of containerToItems) for (const id of v) itemToContainer.set(id, k)
		return { containerToItems, itemToContainer }
	}, [])

	const selectionContainers = useMemo(
		() => buildContainers(visibleGroups, ungroupedDisplayOrder),
		[buildContainers, visibleGroups, ungroupedDisplayOrder],
	)

	// —— 选择：左键主选；Ctrl/Cmd 多选，Shift 区间；右键不打断已选 —— //
	const handleRowSelect = useCallback(
		(e: React.MouseEvent, id: string, mode: 'click' | 'context' = 'click') => {
			startTransition(() => {
				setSelectedIds((prev) => {
					const containers = selectionContainers
					const itemContainer = containers.itemToContainer.get(id)

					const toggle = e.ctrlKey || e.metaKey
					const range = e.shiftKey && lastSelectedRef.current
					let next = prev

					if (range && itemContainer) {
						const anchor = lastSelectedRef.current!
						const anchorContainer = containers.itemToContainer.get(anchor)
						if (anchorContainer && anchorContainer === itemContainer) {
							const list = containers.containerToItems.get(itemContainer) ?? []
							const a = list.indexOf(id)
							const b = list.indexOf(anchor)
							if (a >= 0 && b >= 0) {
								const [lo, hi] = a < b ? [a, b] : [b, a]
								const slice = list.slice(lo, hi + 1)
								next = toggle ? Array.from(new Set([...prev, ...slice])) : slice
							} else {
								next = [id]
							}
						} else {
							next = [id]
						}
					} else if (toggle) {
						next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]
					} else if (mode === 'context') {
						next = prev.includes(id) ? prev : [id]
					} else {
						next = [id]
					}

					lastSelectedRef.current = next.includes(id) ? id : lastSelectedRef.current
					return next
				})
			})
		},
		[selectionContainers, setSelectedIds],
	)

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

	// 剪裁幽灵选择
	useEffect(() => {
		setSelectedIds((sel) => sel.filter((id) => allIds.includes(id)))
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

	// —— 分组操作（本地优先，提交外部只在变更后） —— //
	const createGroup = useCallback(() => {
		const name = prompt('请输入新文件夹名称：')?.trim()
		if (!name) return
		const next: GroupConfig[] = [
			...groupsRef.current,
			{ groupId: genGroupId(), name, pluginIds: [] },
		]
		setGroups(next)
		queueMicrotask(() => onGroupsChangeRef.current?.(next))
	}, [])

	const renameGroup = useCallback((gid0: string) => {
		const idx = groupsRef.current.findIndex((g) => g.groupId === gid0)
		if (idx < 0) return
		const name = prompt('重命名文件夹：', groupsRef.current[idx].name)?.trim()
		if (!name) return
		const next = groupsRef.current.map((g, i) => (i === idx ? { ...g, name } : g))
		setGroups(next)
		queueMicrotask(() => onGroupsChangeRef.current?.(next))
	}, [])

	const deleteGroup = useCallback((gid0: string) => {
		const idx = groupsRef.current.findIndex((g) => g.groupId === gid0)
		if (idx < 0) return
		const victim = groupsRef.current[idx]
		const count = victim?.pluginIds.length ?? 0
		if (!confirm(`删除文件夹「${victim?.name}」？\n将把其中 ${count} 个插件移入“未分组”。`)) return
		const nextUngrouped = unique([...ungroupedRef.current, ...victim.pluginIds])
		const nextGroups = groupsRef.current.filter((_, i) => i !== idx)
		setGroups(nextGroups)
		setUngroupedOrder(nextUngrouped)
		setCollapsed((m) => {
			const copy = { ...m }
			delete copy[gid0]
			return copy
		})
		queueMicrotask(() => onGroupsChangeRef.current?.(nextGroups))
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

	// —— 传感器 —— //
	const sensors = useSensors(
		useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
		useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
	)

	const [dragActiveId, setDragActiveId] = useState<UniqueIdentifier | null>(null)
	const groupIdsSortable = useMemo(() => groups.map((g) => gid(g.groupId)), [groups])
	const LinkComp = LinkComponent

	// —— 小工具：插入/重排 —— //
	const insertKeepOrder = (
		base: string[],
		moving: Set<string>,
		orderedMoving: string[],
		at: number,
	) => {
		const filtered = base.filter((x) => !moving.has(x))
		const idx = Math.max(0, Math.min(at, filtered.length))
		return [...filtered.slice(0, idx), ...orderedMoving, ...filtered.slice(idx)]
	}
	const computeTargetIndex = (
		full: string[],
		movingSet: Set<string>,
		overId?: string,
		opts?: { selfBehavior?: 'before' | 'after' },
	): number => {
		const filtered = full.filter((x) => !movingSet.has(x))
		if (!overId) return filtered.length

		if (movingSet.has(overId)) {
			const behavior = opts?.selfBehavior ?? 'after'
			let first = Number.POSITIVE_INFINITY
			let last = -1
			for (let i = 0; i < full.length; i++) {
				if (movingSet.has(full[i])) {
					if (i < first) first = i
					if (i > last) last = i
				}
			}
			if (behavior === 'after') {
				const next = full.slice(last + 1).find((x) => !movingSet.has(x))
				return next ? Math.max(0, filtered.indexOf(next) + 1) : filtered.length
			}
			const prev = [...full.slice(0, Math.max(0, first))].reverse().find((x) => !movingSet.has(x))
			return prev ? Math.max(0, filtered.indexOf(prev)) : 0
		}

		return Math.max(0, filtered.indexOf(overId))
	}

	// —— Drag handlers —— //
	const handleDragStart = useCallback(
		({ active }: DragStartEvent) => {
			setDragActiveId(active.id)
			if (isIid(active.id)) {
				const pid = fromIid(String(active.id))
				if (!selectedSet.has(pid)) {
					startTransition(() => setSelectedIds([pid]))
					lastSelectedRef.current = pid
				}
			}
			document.body.style.userSelect = 'none'
		},
		[selectedSet, setSelectedIds],
	)

	const handleDragEnd = useCallback(
		({ active, over, delta }: DragEndEvent) => {
			document.body.style.userSelect = ''
			const aId = active?.id as UniqueIdentifier
			const oId = over?.id as UniqueIdentifier | undefined
			setDragActiveId(null)
			if (!oId) return

			const containers = buildContainers(groupsRef.current, ungroupedRef.current)

			// 组排序
			if (isGid(aId) && isGid(oId)) {
				const a = fromGid(String(aId))
				const b = fromGid(String(oId))
				const list = groupsRef.current.map((g) => g.groupId)
				const oldIndex = list.indexOf(a)
				const newIndex = list.indexOf(b)
				if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return
				const next = arrayMove(groupsRef.current, oldIndex, newIndex)
				setGroups(next)
				queueMicrotask(() => onGroupsChangeRef.current?.(next))
				return
			}

			// 条目移动/排序
			if (!isIid(aId)) return

			const moving =
				selectedIds.length > 1 && selectedIds.includes(fromIid(String(aId)))
					? selectedIds
					: [fromIid(String(aId))]
			const movingSet = new Set(moving)
			const orderedMoving = (
				containers.containerToItems.get(
					containers.itemToContainer.get(fromIid(String(aId))) || '',
				) || []
			).filter((x) => movingSet.has(x))

			const fromC = containers.itemToContainer.get(fromIid(String(aId)))
			const toC = isCid(oId)
				? fromCid(String(oId))
				: isIid(oId)
					? (containers.itemToContainer.get(fromIid(String(oId))) ?? 'ROOT_UNGROUPED')
					: undefined
			if (!fromC || !toC) return

			// 同容器：一次性重排
			if (fromC === toC) {
				const full = containers.containerToItems.get(fromC) ?? []
				const targetId = isIid(oId) ? fromIid(String(oId)) : undefined
				const selfBehavior: 'before' | 'after' | undefined =
					targetId && movingSet.has(targetId)
						? (delta?.y ?? 0) < 0
							? 'before'
							: 'after'
						: undefined
				const targetIndex = computeTargetIndex(full, movingSet, targetId, { selfBehavior })
				const nextList = insertKeepOrder(full, movingSet, orderedMoving, targetIndex)
				if (fromC === 'ROOT_UNGROUPED') {
					setUngroupedOrder(nextList)
				} else {
					setGroups((prev) =>
						prev.map((g) => (g.groupId === fromC ? { ...g, pluginIds: nextList } : g)),
					)
				}
				queueMicrotask(() => {
					const next = groupsRef.current
					assertNoDup(next, ungroupedRef.current)
					onGroupsChangeRef.current?.(next)
				})
				return
			}

			// 跨容器：移出 + 插入
			const fromFull = containers.containerToItems.get(fromC) ?? []
			const toFull = containers.containerToItems.get(toC) ?? []
			const targetId = isIid(oId) ? fromIid(String(oId)) : undefined
			const toIndex = computeTargetIndex(toFull, movingSet, targetId)

			if (fromC === 'ROOT_UNGROUPED') {
				setUngroupedOrder(fromFull.filter((x) => !movingSet.has(x)))
			} else {
				setGroups((prev) =>
					prev.map((g) =>
						g.groupId === fromC
							? { ...g, pluginIds: g.pluginIds.filter((x) => !movingSet.has(x)) }
							: g,
					),
				)
			}

			if (toC === 'ROOT_UNGROUPED') {
				setUngroupedOrder((prev) => insertKeepOrder(prev, movingSet, moving, toIndex))
			} else {
				setGroups((prev) =>
					prev.map((g) =>
						g.groupId === toC
							? { ...g, pluginIds: insertKeepOrder(g.pluginIds, movingSet, moving, toIndex) }
							: g,
					),
				)
			}

			queueMicrotask(() => {
				const next = groupsRef.current
				assertNoDup(next, ungroupedRef.current)
				onGroupsChangeRef.current?.(next)
			})
		},
		[buildContainers, selectedIds],
	)

	return (
		<DndContext
			sensors={sensors}
			collisionDetection={closestCorners}
			modifiers={[restrictToVerticalAxis]}
			measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
			onDragStart={handleDragStart}
			onDragEnd={handleDragEnd}
		>
			{/* 根：Grid 分配上下区高度；无分组时让未分组占满 */}
			<Box
				className={className}
				style={{
					display: 'grid',
					gridTemplateRows:
						groups.length > 0 ? 'minmax(0, 1fr) minmax(0, 2fr)' : 'minmax(0, 1fr) auto',
					gap: 4,
					minHeight: 0,
					height: '100%',
					...style,
				}}
				onClick={handleBackgroundClick}
			>
				{/* 未分组：占用上半区；内部滚动 */}
				<Card
					withBorder
					shadow="none"
					radius="xs"
					p={4}
					style={{
						minWidth: 0,
						minHeight: 0,
						display: 'flex',
						flexDirection: 'column',
						overflow: 'hidden',
						background: 'var(--plx-panel-bg)',
						borderColor: 'var(--plx-panel-border)',
					}}
				>
					<Group justify="space-between" align="center" mb={2} wrap="nowrap">
						<Group gap={4} align="center">
							<Text fw={600} size="xs">
								未分组
							</Text>
							<Text size="xs" c="dimmed">
								{visibleUngroupedRunning}/{visibleUngrouped.length}
							</Text>
						</Group>
						<Tooltip label="新建分组" withinPortal withArrow openDelay={200}>
							<ActionIcon
								size="sm"
								variant="light"
								onClick={createGroup}
								disabled={locked}
								aria-label="新建分组"
							>
								<IconFolderPlus size={14} />
							</ActionIcon>
						</Tooltip>
					</Group>

					<DroppableContainer
						id={cid('ROOT_UNGROUPED')}
						disabled={isFiltering || locked}
						minDropHeight={visibleUngrouped.length ? 0 : dh.rowH}
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
							<Stack gap={0} align="stretch" role="list" aria-label="未分组插件">
								{hmrVirtualGroups.map((group) => (
									<Box key={`hmr-group-${group.label}`} style={{ marginTop: 4 }}>
										<Text size="xs" c="dimmed" fw={600} style={{ padding: '2px 2px' }}>
											{group.label}
										</Text>
										{group.pluginIds.map((id) => (
											<SortableRow
												key={id}
												pid={id}
												name={getName(id)}
												running={runningSet.has(id)}
												enabled={enabledSet.has(id)}
												selected={selectedSet.has(id)}
												active={activeSet.has(id)}
												onSelect={handleRowSelect}
												LinkComp={LinkComp}
												disabled={isFiltering || locked}
												meta={getMeta(id)}
												dh={dh}
												sortableId={iid(id)}
											/>
										))}
									</Box>
								))}
								{packageUngrouped.length > 0 && (
									<Box style={{ marginTop: hmrVirtualGroups.length ? 6 : 0 }}>
										{hmrVirtualGroups.length > 0 && (
											<Text size="xs" c="dimmed" fw={600} style={{ padding: '2px 2px' }}>
												包管理安装
											</Text>
										)}
										{packageUngrouped.map((id) => (
											<SortableRow
												key={id}
												pid={id}
												name={getName(id)}
												running={runningSet.has(id)}
												enabled={enabledSet.has(id)}
												selected={selectedSet.has(id)}
												active={activeSet.has(id)}
												onSelect={handleRowSelect}
												LinkComp={LinkComp}
												disabled={isFiltering || locked}
												meta={getMeta(id)}
												dh={dh}
												sortableId={iid(id)}
											/>
										))}
									</Box>
								)}
							</Stack>
						</SortableContext>
					</DroppableContainer>
				</Card>

				{/* 我的分组：有分组时占下半区并可滚动；无分组时收缩为提示行 */}
				{groups.length > 0 ? (
					<Card
						withBorder
						shadow="none"
						radius="xs"
						p={4}
						style={{
							minHeight: 0,
							minWidth: 0,
							overflow: 'hidden',
							display: 'flex',
							flexDirection: 'column',
							background: 'var(--plx-panel-bg)',
							borderColor: 'var(--plx-panel-border)',
						}}
					>
						<Stack gap={2} style={{ minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
							<Group justify="space-between" align="center">
								<Group gap={4} align="center">
									<Text fw={600} size="xs">
										我的分组
									</Text>
									<Text size="xs" c="dimmed">
										{visibleGroups.length} 个
									</Text>
								</Group>
							</Group>

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
													暂无分组，可在上方创建。
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
															enabledSet={enabledSet}
															selectedSet={selectedSet}
															activeSet={activeSet}
															onSelect={handleRowSelect}
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
															onRename={renameGroup}
															onDelete={deleteGroup}
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
				) : (
					<Card
						withBorder
						shadow="none"
						radius="xs"
						p={4}
						style={{
							minWidth: 0,
							background: 'var(--plx-panel-bg)',
							borderColor: 'var(--plx-panel-border)',
						}}
					>
						<Group justify="space-between" align="center">
							<Group gap={4} align="center">
								<Text fw={600} size="xs">
									我的分组
								</Text>
								<Text size="xs" c="dimmed">
									0 个
								</Text>
							</Group>
						</Group>
						<Text c="dimmed" size="xs" pl="xs">
							暂无分组，可在上方创建。
						</Text>
					</Card>
				)}
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
		</DndContext>
	)
}
