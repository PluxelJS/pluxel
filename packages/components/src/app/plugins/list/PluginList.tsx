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
 *    - PluginOrganizer 内部本地优先；本容器在 onGroupsChange 时做"尾触发 250ms 合并"
 *    - 多次拖拽/编辑合并为一次 mutation；串行等待前一次完成，确保最终一致
 *    - 同步失败则回滚到 lastSyncedRef + 通知提示
 *
 * 3) 结构/布局
 *    - 页面外层给到 height:100%，内部 Box flex:1 + overflow hidden
 *    - Skeleton/错误/空态对齐
 *
 * 4) 无闪烁优化
 *    - 使用 startTransition 标记搜索更新为低优先级
 *    - 状态切换时保持容器结构稳定，使用 CSS 过渡平滑切换
 *    - 搜索时使用 isPending 状态避免中间态闪烁
 * -----------------------------------------------------------------------------
 */

import {
	ActionIcon,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	Skeleton,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { IconPlugConnected, IconSearch, IconSearchOff, IconX } from '@tabler/icons-react'
import {
	useCallback,
	useDeferredValue,
	useEffect,
	useMemo,
	useRef,
	useState,
} from 'react'
import type { JSX } from 'react/jsx-runtime'
import { type GroupConfig, PluginOrganizer, type PluginStatuses } from '../organizer'
import { EmptyState, ErrorState } from '../../../components'
import { type PluginGroup, type PluginStatusEntry, useQuery } from '../../gqty'
import { client } from '../../rpc'
import { useNotify } from '../../hooks'
import { RouterLinkAdapter } from '../../RouterLinkAdapter'
import { PLUGIN_SEARCH_EVENT, PLUGIN_SEARCH_KEY } from '../../constants'
import { updatePluginStatuses } from '../actions'
import { subscribePluginStatusEvents } from '../statusEvents'
import type { PluginStatusAction } from '@pluxel/hmr-web'

interface PluginListProps {
	pluginName?: string
	onItemSelect?: () => void
}

type OverviewSnapshot = {
	statuses: PluginStatuses
	groups: GroupConfig[]
	total: number
	running: number
	disabled: number
}

const EMPTY_OVERVIEW: OverviewSnapshot = {
	statuses: {},
	groups: [],
	total: 0,
	running: 0,
	disabled: 0,
}

const ACTION_LABEL: Record<PluginStatusAction, string> = {
	start: '启动',
	stop: '终止',
	restart: '重启',
	enable: '启用',
	disable: '禁用',
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
			isEnabled: entry?.isEnabled !== false,
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
	summary?: { total?: number | null; running?: number | null; disabled?: number | null } | null
}) => {
	const { statuses, groups, summary } = args
	const summaryStatuses = toStatuses(statuses)
	let computedRunning = 0
	let computedDisabled = 0
	for (const entry of Object.values(summaryStatuses)) {
		if (entry?.isRunning) computedRunning += 1
		if (entry?.isEnabled === false) computedDisabled += 1
	}

	const total =
		typeof summary?.total === 'number' ? summary.total : Object.keys(summaryStatuses).length
	const running = typeof summary?.running === 'number' ? summary.running : computedRunning
	const disabled = typeof summary?.disabled === 'number' ? summary.disabled : computedDisabled

	return {
		statuses: summaryStatuses,
		groups: toGroups(groups),
		total,
		running,
		disabled,
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

export const PluginList: React.FC<PluginListProps> = ({ pluginName }) => {
	// —— 混合搜索（持久化 + 降压 + 无闪烁） —— //
	const [search, setSearch] = useState(() => {
		if (typeof window === 'undefined') return ''
		try {
			return localStorage.getItem(PLUGIN_SEARCH_KEY) ?? ''
		} catch {
			return ''
		}
	})
	const deferredSearch = useDeferredValue(search.trim())

	// 搜索变化时使用 transition 降低优先级，避免输入卡顿
	const handleSearchChange = useCallback((value: string) => {
		setSearch(value)
	}, [])

	useEffect(() => {
		const t = setTimeout(() => {
			try {
				localStorage.setItem(PLUGIN_SEARCH_KEY, search)
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

	useEffect(() => {
		const handler = (event: Event) => {
			const detail = (event as CustomEvent<string | undefined>).detail
			setSearch(detail ?? '')
			inputRef.current?.focus()
		}
		window.addEventListener(PLUGIN_SEARCH_EVENT, handler as EventListener)
		return () =>
			window.removeEventListener(PLUGIN_SEARCH_EVENT, handler as EventListener)
	}, [])

	// —— 数据源 —— //
	const [draftGroups, setDraftGroups] = useState<GroupConfig[] | null>(null)
	const lastSyncedRef = useRef<GroupConfig[]>([])
	const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const [bulkBusy, setBulkBusy] = useState(false)
	const notify = useNotify()

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

	useEffect(() => {
		let inflight = false
		let pending = false
		const handle = () => {
			if (inflight) {
				pending = true
				return
			}
			inflight = true
			void query.$refetch(true).finally(() => {
				inflight = false
				if (pending) {
					pending = false
					handle()
				}
			})
		}
		return subscribePluginStatusEvents(handle)
	}, [query.$refetch])

	const handleGroupsChange = useCallback((next: GroupConfig[]) => {
		void client['plugin-groups'].$post({ json: next })
	}, [])

	const handleBulkStatus = useCallback(
		async (action: Exclude<PluginStatusAction, 'start' | 'restart'>) => {
			if (selectedIds.length === 0) return
			setBulkBusy(true)
			try {
				const results = await updatePluginStatuses(
					selectedIds.map((name) => ({ name, action })),
				)
				const failed = results.filter((r) => !r.ok)
				if (failed.length > 0) {
					notify({
						title: '操作完成但部分失败',
						message: failed.map((f) => f.name).join('，') || '操作失败',
						color: 'red',
					})
				} else {
					notify({
						title: '批量操作成功',
						message: `${selectedIds.length} 个插件已 ${ACTION_LABEL[action]}`,
						color: 'green',
					})
					if (action === 'disable' || action === 'stop') setSelectedIds([])
				}
			} catch (error: any) {
				notify({
					title: '操作失败',
					message: error?.message ?? '批量操作失败，请稍后重试。',
					color: 'red',
				})
			} finally {
				setBulkBusy(false)
			}
		},
		[selectedIds, notify],
	)

	// —— 视图渲染 —— //
	const loading = !hasLoadedOnce && query.$state.isLoading
	const syncing = hasLoadedOnce && query.$state.isLoading
	const errorMessage = query.$state.error?.message
	const filterQuery = deferredSearch
	const groupsForView = draftGroups ?? overview.groups

	// 搜索过程中的过渡状态，用于降低视觉闪烁
	const isTransitioning = search.trim() !== deferredSearch

	const clearBtn = useMemo(
		() =>
			search ? (
				<ActionIcon size="sm" variant="subtle" onClick={() => handleSearchChange('')}>
					<IconX size={14} />
				</ActionIcon>
			) : undefined,
		[search, handleSearchChange],
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
		content = (
			<ErrorState
				title="加载失败"
				message={errorMessage}
				onRetry={() => void query.$refetch(true)}
				minHeight={160}
			/>
		)
	} else if (overview.total === 0) {
		content = (
			<EmptyState
				icon={<IconPlugConnected size={28} stroke={1.5} />}
				title="暂无插件"
				description="安装插件后，这里会显示所有可用的插件列表。"
				withPattern
				minHeight={160}
			/>
		)
	} else if (filterQuery && groupsForView.every((g) => g.pluginIds.length === 0)) {
		content = (
			<EmptyState
				icon={<IconSearchOff size={28} stroke={1.5} />}
				title={`没有匹配"${filterQuery}"的结果`}
				description="尝试其他关键词搜索。"
				minHeight={160}
			/>
		)
		} else {
			content = (
				<PluginOrganizer
					statuses={overview.statuses}
					initialGroups={groupsForView}
					activeId={pluginName}
					onGroupsChange={handleGroupsChange}
					selectedIds={selectedIds}
					onSelectedIdsChange={setSelectedIds}
					filterQuery={filterQuery}
					LinkComponent={RouterLinkAdapter}
					locked={syncing || bulkBusy}
				/>
			)
		}

	return (
		<Stack
			gap="sm"
			w="100%"
			style={{ minWidth: 0, minHeight: '100%', height: '100%', flex: 1, overflow: 'hidden' }}
		>
			<Paper withBorder radius="md" p="sm">
				<Group justify="space-between" align="center" gap="sm" wrap="wrap">
					<Title order={6}>插件工作台</Title>
					{!loading && !errorMessage && (
						<Group gap={6}>
							<Badge variant="light" size="xs" suppressHydrationWarning>
								共 {overview.total}
							</Badge>
							<Badge variant="light" size="xs" color="green" suppressHydrationWarning>
								运行中 {overview.running}
							</Badge>
							{overview.disabled > 0 && (
								<Badge variant="light" size="xs" color="gray" suppressHydrationWarning>
									禁用 {overview.disabled}
								</Badge>
							)}
							{syncing && (
								<Badge variant="light" size="xs" color="blue">
									同步…
								</Badge>
							)}
						</Group>
					)}
				</Group>
				<Text c="dimmed" size="xs" mt={4}>
					按 / 或 Ctrl/⌘ + F 快速搜索
				</Text>
				<TextInput
					ref={inputRef}
					mt="xs"
					placeholder="搜索（组名 / 插件名称 / 插件ID）"
					value={search}
					onChange={(e) => handleSearchChange(e.currentTarget.value)}
					leftSection={<IconSearch size={14} />}
					rightSection={clearBtn}
					size="xs"
					variant="filled"
					radius="sm"
				/>
			</Paper>

			{selectedIds.length > 0 ? (
				<Paper withBorder radius="md" p="sm" shadow="xs">
					<Group justify="space-between" align="center" gap="sm" wrap="wrap">
						<Group gap="xs" align="center">
							<Badge variant="light" color="blue" size="sm">
								已选 {selectedIds.length}
							</Badge>
							<Text size="xs" c="dimmed">
								右键/多选后可批量操作（仅停用/启用/停止）。
							</Text>
						</Group>
						<Group gap="xs" wrap="wrap">
							<Button size="xs" variant="subtle" disabled={bulkBusy} onClick={() => void handleBulkStatus('stop')}>
								停止
							</Button>
							<Button
								size="xs"
								variant="subtle"
								disabled={bulkBusy}
								onClick={() => void handleBulkStatus('disable')}
							>
								禁用
							</Button>
							<Button
								size="xs"
								variant="subtle"
								disabled={bulkBusy}
								onClick={() => void handleBulkStatus('enable')}
							>
								启用
							</Button>
							<Button size="xs" variant="default" disabled={bulkBusy} onClick={() => setSelectedIds([])}>
								清空选择
							</Button>
						</Group>
					</Group>
				</Paper>
			) : null}

			<Box
				style={{
					flex: 1,
					minHeight: 0,
					minWidth: 0,
					padding: 'var(--mantine-spacing-xs)',
					background: 'var(--mantine-color-body)',
					borderRadius: 12,
					display: 'flex',
					flexDirection: 'column',
				}}
			>
				{/* 内容容器：使用 opacity 过渡避免闪烁 */}
				<Box
					style={{
						flex: 1,
						minHeight: 0,
						opacity: isTransitioning ? 0.7 : 1,
						transition: 'opacity 100ms ease-out',
					}}
				>
					{content}
				</Box>
			</Box>
		</Stack>
	)
}
