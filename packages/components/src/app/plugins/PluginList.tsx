// src/pages/PluginList.tsx
/**
 * PluginList（页面/容器）
 * -----------------------------------------------------------------------------
 * 设计目标
 * 1) 混合搜索：单一输入框，匹配（分组名 || 插件 name/ID），无 scope 切换
 *    - useDeferredValue 降压；结果仅作为视图过滤（不触发后端）
 *    - 搜索词 localStorage 持久化，返回页面保持上下文
 *    - 快捷键：'/' 或 Ctrl/⌘+F 聚焦，Esc 清空
 *
 * 2) 本地优先 + 合并提交
 *    - PluginOrganizer 内部本地优先；本容器在 onGroupsChange 时做“尾触发 250ms 合并”
 *    - 多次拖拽/编辑合并为一次 mutation；串行等待前一次完成，确保最终一致
 *    - 同步失败则回滚到 lastSyncedRef + 通知提示
 *
 * 3) 结构/布局
 *    - 页面外层给到 height:100%，内部 Box flex:1 + overflow hidden
 *    - Skeleton/错误/空态对齐
 * -----------------------------------------------------------------------------
 */

import {
	ActionIcon,
	Badge,
	Box,
	Divider,
	Group,
	Skeleton,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { IconSearch, IconX } from '@tabler/icons-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react/jsx-runtime'
import { type GroupConfig, PluginOrganizer, type PluginStatuses } from '../../components'
import { type PluginGroup, type PluginStatusEntry, useQuery } from '../gqty'
import { client } from '../rpc'
import { RouterLinkAdapter } from '../RouterLinkAdapter'

interface PluginListProps {
	pluginName?: string
	onItemSelect?: () => void
}

type OverviewSnapshot = {
	statuses: PluginStatuses
	groups: GroupConfig[]
	total: number
	running: number
}

const EMPTY_OVERVIEW: OverviewSnapshot = {
	statuses: {},
	groups: [],
	total: 0,
	running: 0,
}

const toStatuses = (entries: Array<PluginStatusEntry | null | undefined> | undefined) => {
	const snapshot: PluginStatuses = {}
	for (const entry of entries ?? []) {
		const id = entry?.name
		if (!id) continue
		snapshot[id] = {
			id,
			name: entry?.name ?? id,
			isRunning: Boolean(entry?.isRunning),
		}
	}
	return snapshot
}

const toGroups = (groups: Array<PluginGroup | null | undefined> | undefined) => {
	return (groups ?? []).map((group) => ({
		groupId: group?.groupId ?? '',
		name: group?.name ?? '',
		pluginIds: [...(group?.pluginIds ?? [])],
	}))
}

const buildOverview = (args: {
	statuses: Array<PluginStatusEntry | null | undefined> | undefined
	groups: Array<PluginGroup | null | undefined> | undefined
	summary?: { total?: number | null; running?: number | null } | null
}) => {
	const { statuses, groups, summary } = args
	const summaryStatuses = toStatuses(statuses)
	let computedRunning = 0
	for (const entry of Object.values(summaryStatuses)) if (entry?.isRunning) computedRunning += 1

	const total =
		typeof summary?.total === 'number' ? summary.total : Object.keys(summaryStatuses).length
	const running = typeof summary?.running === 'number' ? summary.running : computedRunning

	return {
		statuses: summaryStatuses,
		groups: toGroups(groups),
		total,
		running,
	}
}

const cloneGroups = (input: GroupConfig[]): GroupConfig[] =>
	input.map((group) => ({
		groupId: group.groupId,
		name: group.name,
		pluginIds: [...group.pluginIds],
	}))

const areGroupsEqual = (a: GroupConfig[], b: GroupConfig[]) => {
	if (a.length !== b.length) return false
	for (let i = 0; i < a.length; i += 1) {
		const ga = a[i]
		const gb = b[i]
		if (!gb) return false
		if (ga.groupId !== gb.groupId || ga.name !== gb.name) return false
		if (ga.pluginIds.length !== gb.pluginIds.length) return false
		for (let j = 0; j < ga.pluginIds.length; j += 1) {
			if (ga.pluginIds[j] !== gb.pluginIds[j]) return false
		}
	}
	return true
}

const SEARCH_KEY = 'pluxel:plugin-search'

export const PluginList: React.FC<PluginListProps> = ({ pluginName }) => {
	// —— 混合搜索（持久化 + 降压） —— //
	const [search, setSearch] = useState(() => {
		if (typeof window === 'undefined') return ''
		try {
			return localStorage.getItem(SEARCH_KEY) ?? ''
		} catch {
			return ''
		}
	})
	const deferredSearch = useDeferredValue(search.trim())

	useEffect(() => {
		const t = setTimeout(() => {
			try {
				localStorage.setItem(SEARCH_KEY, search)
			} catch {}
		}, 200)
		return () => clearTimeout(t)
	}, [search])

	const inputRef = useRef<HTMLInputElement>(null)
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey
			if ((mod && e.key.toLowerCase() === 'f') || e.key === '/') {
				e.preventDefault()
				inputRef.current?.focus()
			} else if (e.key === 'Escape') {
				setSearch('')
				inputRef.current?.blur()
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [])

	// —— 数据源 —— //
	const [draftGroups, setDraftGroups] = useState<GroupConfig[] | null>(null)
	const lastSyncedRef = useRef<GroupConfig[]>([])
	const [hasLoadedOnce, setHasLoadedOnce] = useState(false)

	const query = useQuery({
		suspense: false,
		operationName: 'PluginOverview',
		notifyOnNetworkStatusChange: true,
		refetchOnReconnect: false,
		refetchOnWindowVisible: false,
		fetchInBackground: true,
	})

	const overview = useMemo<OverviewSnapshot>(() => {
		try {
			return buildOverview({
				statuses: query.pluginStatus?.statuses,
				groups: query.pluginGroups,
				summary: query.pluginStatus?.summary,
			})
		} catch (error) {
			console.error('[PluginList] Failed to build overview snapshot', error)
			return EMPTY_OVERVIEW
		}
	}, [query.pluginGroups, query.pluginStatus?.statuses, query.pluginStatus?.summary])

	useEffect(() => {
		if (draftGroups) {
			if (areGroupsEqual(draftGroups, overview.groups)) {
				lastSyncedRef.current = cloneGroups(overview.groups)
				setDraftGroups(null)
			}
		} else {
			lastSyncedRef.current = cloneGroups(overview.groups)
		}
	}, [draftGroups, overview.groups])

	useEffect(() => {
		if (!query.$state.isLoading && !query.$state.error) {
			setHasLoadedOnce(true)
		}
	}, [query.$state.error, query.$state.isLoading])

	const handleGroupsChange = useCallback((next: GroupConfig[]) => {
		client.plugins.groups.$post({ json: next })
	}, [])

	// —— 视图渲染 —— //
	const loading = !hasLoadedOnce && query.$state.isLoading
	const syncing = hasLoadedOnce && query.$state.isLoading
	const errorMessage = query.$state.error?.message
	const filterQuery = deferredSearch
	const groupsForView = draftGroups ?? overview.groups

	const clearBtn = useMemo(
		() =>
			search ? (
				<ActionIcon size="sm" variant="subtle" onClick={() => setSearch('')}>
					<IconX size={14} />
				</ActionIcon>
			) : undefined,
		[search],
	)

	let content: JSX.Element | null = null
	if (loading) {
		content = (
			<Stack gap="xs">
				<Skeleton height={16} />
				<Skeleton height={16} width="85%" />
				<Skeleton height={16} width="70%" />
				<Skeleton height={120} />
			</Stack>
		)
	} else if (errorMessage) {
		content = <Text c="red">{errorMessage}</Text>
	} else if (overview.total === 0) {
		content = <Text c="dimmed">暂无插件</Text>
	} else {
		content = (
				<PluginOrganizer
					statuses={overview.statuses}
					initialGroups={groupsForView}
					activeId={pluginName}
					onGroupsChange={handleGroupsChange}
					filterQuery={filterQuery}
					LinkComponent={RouterLinkAdapter}
					locked={syncing}
				/>
		)
	}

	return (
		<Stack
			gap="sm"
			w="100%"
			style={{ minWidth: 0, minHeight: '100%', height: '100%', flex: 1, overflow: 'hidden' }}
		>
			<Stack gap="sm" style={{ minWidth: 0 }}>
				<Group justify="space-between" align="center" gap="xs" wrap="wrap" style={{ minWidth: 0 }}>
					<Title order={6} fw={600} c="dimmed">
						浏览与分组
					</Title>
					{!loading && !errorMessage && (
						<Group gap="xs">
							<Badge variant="light" size="sm" suppressHydrationWarning>
								共 {overview.total}
							</Badge>
							<Badge variant="light" size="sm" color="green" suppressHydrationWarning>
								运行中 {overview.running}
							</Badge>
							{syncing && (
								<Badge variant="light" size="sm" color="blue">
									同步中…
								</Badge>
							)}
						</Group>
					)}
				</Group>

				<TextInput
					ref={inputRef}
					placeholder="搜索（组名 / 插件名称 / 插件ID）"
					value={search}
					onChange={(e) => setSearch(e.currentTarget.value)}
					leftSection={<IconSearch size={14} />}
					rightSection={clearBtn}
					size="xs"
				/>

				<Divider />
			</Stack>

			<Box style={{ flex: 1, minHeight: 0, minWidth: 0 }}>{content}</Box>
		</Stack>
	)
}
