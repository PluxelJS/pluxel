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

import { ActionIcon, Box, Group, Paper, Skeleton, Stack } from '@mantine/core'
import { IconCornerUpLeft, IconPlugConnected, IconSearchOff } from '@tabler/icons-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react/jsx-runtime'
import { type GroupConfig, PluginOrganizer } from '../organizer'
import { EmptyState, ErrorState } from '../../../components'
import { useNotify } from '../../hooks'
import { RouterLinkAdapter } from '../../RouterLinkAdapter'
import { PLUGIN_SEARCH_EVENT, PLUGIN_SEARCH_KEY } from '../../constants'
import { updatePluginStatuses } from '../actions'
import { requestPluginOverviewRefetch, setPluginOverviewGroups, usePluginOverview } from '../data'
import type { PluginStatusAction } from '../../../runtime'
import { useRuntimeTransportClient } from '../../../runtime'
import { invalidate } from '../../data/invalidations'
import {
	EMPTY_OVERVIEW,
	areGroupsEqual,
	buildOverview,
	cloneGroups,
	type OverviewSnapshot,
} from './state/overview'
import { parseSearchTokens } from '../shared/search'
import { BulkActionsBar, type BulkAction } from './components/BulkActionsBar'
import { SearchBar, type StatusFilterState } from './components/SearchBar'

interface PluginListProps {
	pluginName?: string
	onItemSelect?: () => void
}

const ACTION_LABEL: Record<PluginStatusAction, string> = {
	start: '启动',
	stop: '终止',
	restart: '重启',
	enable: '启用',
	disable: '禁用',
}
const STATUS_FILTER_KEY = 'pluxel:plugin-status-filter'

export const PluginList: React.FC<PluginListProps> = ({ pluginName }) => {
	const transport = useRuntimeTransportClient()
	const [statusFilter, setStatusFilter] = useState<StatusFilterState>(() => {
		if (typeof window === 'undefined') {
			return { running: true, stopped: true, disabled: true }
		}
		try {
			const raw = localStorage.getItem(STATUS_FILTER_KEY)
			if (!raw) return { running: true, stopped: true, disabled: true }
			const parsed = JSON.parse(raw) as Partial<StatusFilterState>
			return {
				running: parsed.running !== false,
				stopped: parsed.stopped !== false,
				disabled: parsed.disabled !== false,
			}
		} catch {
			return { running: true, stopped: true, disabled: true }
		}
	})
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

	useEffect(() => {
		if (typeof window === 'undefined') return
		try {
			localStorage.setItem(STATUS_FILTER_KEY, JSON.stringify(statusFilter))
		} catch {}
	}, [statusFilter])

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
		return () => window.removeEventListener(PLUGIN_SEARCH_EVENT, handler as EventListener)
	}, [])

	// —— 数据源 —— //
	const [draftGroups, setDraftGroups] = useState<GroupConfig[] | null>(null)
	const lastSyncedRef = useRef<GroupConfig[]>([])
	const [hasLoadedOnce, setHasLoadedOnce] = useState(false)
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const [bulkBusy, setBulkBusy] = useState(false)
	const [organizerResetToken, setOrganizerResetToken] = useState(0)
	const notify = useNotify()

	const overviewState = usePluginOverview()

	const overview = useMemo<OverviewSnapshot>(() => {
		try {
			return buildOverview({
				statuses: overviewState.overview?.status?.statuses,
				groups: overviewState.overview?.groups,
				summary: overviewState.overview?.status?.summary,
			})
		} catch (error) {
			console.error('[PluginList] Failed to build overview snapshot', error)
			return EMPTY_OVERVIEW
		}
	}, [
		overviewState.overview?.groups,
		overviewState.overview?.status?.statuses,
		overviewState.overview?.status?.summary,
	])

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
		if (!overviewState.isLoading && !overviewState.error) {
			setHasLoadedOnce(true)
		}
	}, [overviewState.error, overviewState.isLoading])

	const commitTimerRef = useRef<number | null>(null)
	const inflightCommitRef = useRef<Promise<void> | null>(null)
	const pendingCommitRef = useRef<GroupConfig[] | null>(null)
	const queuedCommitRef = useRef(false)

	const flushGroupCommit = useCallback(() => {
		const pending = pendingCommitRef.current
		if (!pending) return
		if (inflightCommitRef.current) {
			queuedCommitRef.current = true
			return
		}
		pendingCommitRef.current = null
		const task = transport
			.withRpc((rpc) => rpc.updatePluginGroups(pending))
			.then((result) => {
				const nextGroups = Array.isArray(result) ? result : pending
				lastSyncedRef.current = cloneGroups(nextGroups)
				setDraftGroups(null)
				setPluginOverviewGroups(nextGroups)
				invalidate({ topic: 'plugin-groups', reason: 'rpc' })
			})
			.catch((error: any) => {
				const message = error?.message ?? '分组同步失败，请稍后重试。'
				notify({ title: '同步失败', message, color: 'red' })
				const rollback = cloneGroups(lastSyncedRef.current)
				setDraftGroups(rollback)
				setPluginOverviewGroups(rollback)
				setOrganizerResetToken((n) => n + 1)
			})
			.finally(() => {
				inflightCommitRef.current = null
				if (queuedCommitRef.current || pendingCommitRef.current) {
					queuedCommitRef.current = false
					flushGroupCommit()
				}
			})
		inflightCommitRef.current = task
	}, [transport, notify])

	const handleGroupsChange = useCallback(
		(next: GroupConfig[]) => {
			if (areGroupsEqual(next, lastSyncedRef.current) && !pendingCommitRef.current) return
			pendingCommitRef.current = cloneGroups(next)
			setDraftGroups(next)
			if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current)
			commitTimerRef.current = window.setTimeout(flushGroupCommit, 250)
		},
		[flushGroupCommit],
	)

	useEffect(() => {
		return () => {
			if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current)
		}
	}, [])

	const handleBulkStatus = useCallback(
		async (action: Exclude<PluginStatusAction, 'start' | 'restart'>) => {
			if (selectedIds.length === 0) return
			const batch = [...selectedIds]
			setBulkBusy(true)
			try {
				const results = await updatePluginStatuses(batch.map((name) => ({ name, action })))
				const failed = results.filter((r) => !r.ok)
				if (failed.length > 0) {
					notify({
						title: '操作完成但部分失败',
						message: failed.map((f) => f.name).join('，') || '操作失败',
						color: 'red',
					})
				} else {
					if (action === 'disable' || action === 'stop') {
						const undoAction: PluginStatusAction = action === 'disable' ? 'enable' : 'start'
						notify({
							title: '批量操作成功',
							message: (
								<Group gap={6} align="center" wrap="nowrap">
									<Box component="span">
										{batch.length} 个插件已 {ACTION_LABEL[action]}
									</Box>
									<ActionIcon
										size="sm"
										variant="subtle"
										title="撤销"
										aria-label="撤销"
										onClick={() => {
											void (async () => {
												setBulkBusy(true)
												try {
													const undoResults = await updatePluginStatuses(
														batch.map((name) => ({ name, action: undoAction })),
													)
													const undoFailed = undoResults.filter((r) => !r.ok)
													if (undoFailed.length > 0) {
														notify({
															title: '撤销失败',
															message: undoFailed.map((f) => f.name).join('，') || '撤销失败',
															color: 'red',
														})
													} else {
														notify({
															title: '已撤销',
															message: `${batch.length} 个插件已 ${ACTION_LABEL[undoAction]}`,
															color: 'green',
														})
													}
												} catch (error: any) {
													notify({
														title: '撤销失败',
														message: error?.message ?? '撤销失败，请稍后重试。',
														color: 'red',
													})
												} finally {
													setBulkBusy(false)
												}
											})()
										}}
									>
										<IconCornerUpLeft size={14} />
									</ActionIcon>
								</Group>
							),
							color: 'green',
							autoClose: 4000,
						})
					} else {
						notify({
							title: '批量操作成功',
							message: `${batch.length} 个插件已 ${ACTION_LABEL[action]}`,
							color: 'green',
						})
					}
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

	const handleBulkAction = useCallback(
		(action: BulkAction) => {
			if (action === 'clear') {
				setSelectedIds([])
				return
			}
			void handleBulkStatus(action)
		},
		[handleBulkStatus],
	)

	// —— 视图渲染 —— //
	const loading = !hasLoadedOnce && overviewState.isLoading
	const syncing = hasLoadedOnce && overviewState.isLoading
	const errorMessage = !overviewState.hasSnapshot ? overviewState.error : undefined
	const filterQuery = deferredSearch
	const groupsForView = draftGroups ?? overview.groups
	const searchTokens = useMemo(() => parseSearchTokens(filterQuery), [filterQuery])
	const hasStatusFilter = !statusFilter.running || !statusFilter.stopped || !statusFilter.disabled

	// 搜索过程中的过渡状态，用于降低视觉闪烁
	const isTransitioning = search.trim() !== deferredSearch

	const hasAnyMatch = useMemo(() => {
		const { plain, pkg, tag, version, id: idTokens } = searchTokens
		const hasQuery =
			plain.length > 0 ||
			pkg.length > 0 ||
			tag.length > 0 ||
			version.length > 0 ||
			idTokens.length > 0
		if (!hasQuery && !hasStatusFilter) return true

		const groupNameMatches = (name: string) =>
			plain.length > 0 && plain.every((term) => name.toLowerCase().includes(term))

		for (const group of groupsForView) {
			if (group.name && groupNameMatches(group.name)) return true
		}

		for (const [pid, st] of Object.entries(overview.statuses)) {
			const name = (st?.name || '').toLowerCase()
			const pkgName = (st?.packageName || '').toLowerCase()
			const tagValue = (st?.tag || '').toLowerCase()
			const versionValue = (st?.version || '').toLowerCase()
			const idValue = pid.toLowerCase()

			const running = !!st?.isRunning
			const enabled = st?.isEnabled !== false
			const disabled = !enabled
			const stopped = enabled && !running
			const statusOk =
				(statusFilter.running && running) ||
				(statusFilter.stopped && stopped) ||
				(statusFilter.disabled && disabled)

			if (!statusOk) continue

			const plainOk = plain.every((term) =>
				[name, pkgName, tagValue, versionValue, idValue].some((field) => field.includes(term)),
			)
			const pkgOk = pkg.every((term) => pkgName.includes(term))
			const tagOk = tag.every((term) => tagValue.includes(term))
			const versionOk = version.every((term) => versionValue.includes(term))
			const idOk = idTokens.every((term) => idValue.includes(term))

			if (plainOk && pkgOk && tagOk && versionOk && idOk) return true
		}
		return false
	}, [groupsForView, hasStatusFilter, overview.statuses, searchTokens, statusFilter])

	const toggleStatusFilter = useCallback((key: keyof StatusFilterState) => {
		setStatusFilter((prev) => ({ ...prev, [key]: !prev[key] }))
	}, [])

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
				onRetry={() => void requestPluginOverviewRefetch()}
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
	} else if ((filterQuery || hasStatusFilter) && !hasAnyMatch) {
		const emptyTitle = filterQuery ? `没有匹配"${filterQuery}"的结果` : '没有符合筛选条件的插件'
		content = (
			<EmptyState
				icon={<IconSearchOff size={28} stroke={1.5} />}
				title={emptyTitle}
				description="尝试其他关键词搜索。"
				minHeight={160}
			/>
		)
	} else {
		content = (
			<PluginOrganizer
				key={organizerResetToken}
				statuses={overview.statuses}
				initialGroups={groupsForView}
				activeId={pluginName}
				onGroupsChange={handleGroupsChange}
				selectedIds={selectedIds}
				onSelectedIdsChange={setSelectedIds}
				filterQuery={filterQuery}
				statusFilter={statusFilter}
				LinkComponent={RouterLinkAdapter}
				density="ultra"
				locked={syncing || bulkBusy}
			/>
		)
	}

	return (
		<Stack
			gap={4}
			w="100%"
			style={{ minWidth: 0, minHeight: '100%', height: '100%', flex: 1, overflow: 'hidden' }}
		>
			<Paper withBorder radius="xs" p={4}>
				<SearchBar
					value={search}
					onChange={handleSearchChange}
					inputRef={inputRef}
					statusFilter={statusFilter}
					onToggleStatus={toggleStatusFilter}
				/>
			</Paper>

			{selectedIds.length > 0 ? (
				<BulkActionsBar count={selectedIds.length} busy={bulkBusy} onAction={handleBulkAction} />
			) : null}

			<Box
				style={{
					flex: 1,
					minHeight: 0,
					minWidth: 0,
					padding: 2,
					background: 'var(--mantine-color-body)',
					borderRadius: 6,
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
