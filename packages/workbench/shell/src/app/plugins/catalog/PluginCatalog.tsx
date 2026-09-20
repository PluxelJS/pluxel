/** Derived Plugin catalog search, organization, bulk actions, and layout persistence. */

import { ActionIcon, Box, Group, Skeleton, Stack } from '@mantine/core'
import { pluginNodeIndexKey } from '@pluxel/core'
import {
	IconChevronLeft,
	IconCornerUpLeft,
	IconKeyboard,
	IconPlugConnected,
	IconSearchOff,
} from '@tabler/icons-react'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { JSX } from 'react/jsx-runtime'
import { PluginOrganizer } from './organizer/PluginOrganizer'
import type { GroupConfig } from './organizer/types'
import { EmptyState, ErrorState } from '../../../components'
import { useNotify } from '../../hooks/useNotify'
import { RouterLinkAdapter } from '../../router/RouterLinkAdapter'
import { PLUGIN_SEARCH_EVENT, PLUGIN_SEARCH_KEY } from '../../constants'
import { setPluginAutoStarts } from '../pluginStatusActions'
import { usePluginOverview } from '../pluginOverview'
import { runtimeErrorMessage, useRuntimeManagementClient } from '../../../runtime'
import {
	EMPTY_OVERVIEW,
	areGroupsEqual,
	buildOverview,
	cloneGroups,
	type OverviewSnapshot,
} from './catalogOverview'
import {
	DEFAULT_STATUS_FILTER,
	hasActiveSearchTokens,
	hasActiveStatusFilter,
	isEditableTarget,
	matchesGroupSearch,
	matchesPluginSearch,
	type StatusFilterState,
} from './filterModel'
import { parseSearchTokens } from './searchTokens'
import { BulkActionsBar, type BulkAction } from './components/BulkActionsBar'
import { CatalogHelpModal } from './components/CatalogHelpModal'
import { SearchBar } from './components/SearchBar'

interface PluginCatalogProps {
	onCollapse?: () => void
	pluginRoute?: string
}

const STATUS_FILTER_KEY = 'pluxel:plugin-status-filter'

class PluginCatalogLayoutPersistenceUnknownError extends Error {}

export const PluginCatalog: React.FC<PluginCatalogProps> = ({ onCollapse, pluginRoute }) => {
	const management = useRuntimeManagementClient()
	const queryClient = useQueryClient()
	const [statusFilter, setStatusFilter] = useState<StatusFilterState>(() => {
		if (typeof window === 'undefined') {
			return DEFAULT_STATUS_FILTER
		}
		try {
			const raw = localStorage.getItem(STATUS_FILTER_KEY)
			if (!raw) return DEFAULT_STATUS_FILTER
			const parsed = JSON.parse(raw) as Partial<StatusFilterState>
			return {
				running: parsed.running !== false,
				stopped: parsed.stopped !== false,
				unavailable: parsed.unavailable !== false,
			}
		} catch {
			return DEFAULT_STATUS_FILTER
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
	const [selectedIds, setSelectedIds] = useState<string[]>([])
	const [helpOpened, setHelpOpened] = useState(false)

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
	const resetFilters = useCallback(() => {
		setSearch('')
		setStatusFilter(DEFAULT_STATUS_FILTER)
	}, [])
	const resetStatusFilter = useCallback(() => {
		setStatusFilter(DEFAULT_STATUS_FILTER)
	}, [])
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const editableTarget = isEditableTarget(e.target)
			const mod = e.ctrlKey || e.metaKey
			if ((mod && e.key.toLowerCase() === 'f') || (!editableTarget && e.key === '/')) {
				e.preventDefault()
				inputRef.current?.focus()
			} else if (e.key === 'F1' || (!editableTarget && e.key === '?')) {
				e.preventDefault()
				setHelpOpened(true)
			} else if (!editableTarget && e.altKey && ['1', '2', '3'].includes(e.key)) {
				e.preventDefault()
				const key = e.key === '1' ? 'running' : e.key === '2' ? 'stopped' : ('unavailable' as const)
				setStatusFilter((prev) => ({ ...prev, [key]: !prev[key] }))
			} else if (e.key === 'Escape') {
				if (helpOpened) {
					e.preventDefault()
					setHelpOpened(false)
					return
				}
				if (selectedIds.length > 0) {
					e.preventDefault()
					setSelectedIds([])
					return
				}
				if (search || hasActiveStatusFilter(statusFilter)) {
					e.preventDefault()
					resetFilters()
					inputRef.current?.blur()
				}
			}
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [helpOpened, resetFilters, search, selectedIds.length, setSelectedIds, statusFilter])

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
	const [bulkBusy, setBulkBusy] = useState(false)
	const [layoutSaving, setLayoutSaving] = useState(false)
	const [organizerResetToken, setOrganizerResetToken] = useState(0)
	const notify = useNotify()

	const overviewState = usePluginOverview()
	const refetchOverview = overviewState.refetch

	const overview = useMemo<OverviewSnapshot>(() => {
		try {
			return buildOverview({
				statuses: overviewState.overview?.status?.statuses,
				sections: overviewState.overview?.sections,
				summary: overviewState.overview?.status?.summary,
			})
		} catch (error) {
			console.error('[PluginCatalog] Failed to build overview snapshot', error)
			return EMPTY_OVERVIEW
		}
	}, [
		overviewState.overview?.sections,
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

	const commitTimerRef = useRef<number | null>(null)
	const inflightCommitRef = useRef<Promise<void> | null>(null)
	const pendingCommitRef = useRef<GroupConfig[] | null>(null)
	const queuedCommitRef = useRef(false)

	const flushGroupCommit = useCallback(() => {
		const pending = pendingCommitRef.current
		if (!pending) return
		if (inflightCommitRef.current !== null) {
			queuedCommitRef.current = true
			return
		}
		pendingCommitRef.current = null
		const task = Promise.resolve()
			.then(() =>
				management.catalog.updateLayout({
					sections: pending.map((group) => ({
						sectionId: group.groupId,
						name: group.name,
						nodes: group.pluginIds.map((id) => {
							const status = overview.statuses[id]
							if (!status) throw new Error(`Plugin section references unknown catalog id: ${id}`)
							return status.address
						}),
					})),
				}),
			)
			.then(async (result): Promise<undefined> => {
				if (result.ok === false) {
					if (result.code === 'persistence_failed') {
						throw new PluginCatalogLayoutPersistenceUnknownError(result.error)
					}
					throw new Error(result.error)
				}
				const idsByAddress = new Map(
					Object.values(overview.statuses).map((status) => [
						pluginNodeIndexKey(status.address),
						status.id,
					]),
				)
				lastSyncedRef.current = result.sections.map((section) => ({
					groupId: section.sectionId,
					name: section.name,
					pluginIds: section.nodes.flatMap((node) => {
						const id = idsByAddress.get(pluginNodeIndexKey(node))
						return id === undefined ? [] : [id]
					}),
				}))
				await refetchOverview()
				if (!pendingCommitRef.current) {
					setDraftGroups(null)
					setOrganizerResetToken((n) => n + 1)
				}
				return undefined
			})
			.catch(async (error: unknown): Promise<void> => {
				const message = runtimeErrorMessage(error, '分组同步失败，请稍后重试。')
				notify({ title: '同步失败', message, color: 'red' })
				if (error instanceof PluginCatalogLayoutPersistenceUnknownError) {
					await refetchOverview()
					if (!pendingCommitRef.current) {
						setDraftGroups(null)
						setOrganizerResetToken((n) => n + 1)
					}
					return
				}
				if (!pendingCommitRef.current) {
					const rollback = cloneGroups(lastSyncedRef.current)
					setDraftGroups(rollback)
					setOrganizerResetToken((n) => n + 1)
				}
			})
			.finally(() => {
				inflightCommitRef.current = null
				if (queuedCommitRef.current || pendingCommitRef.current) {
					queuedCommitRef.current = false
					flushGroupCommit()
				} else {
					setLayoutSaving(false)
				}
			})
		inflightCommitRef.current = task
	}, [management.catalog, notify, overview.statuses, refetchOverview])

	const handleGroupsChange = useCallback(
		(next: GroupConfig[]) => {
			setLayoutSaving(true)
			pendingCommitRef.current = cloneGroups(next)
			setDraftGroups(next)
			if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current)
			commitTimerRef.current = window.setTimeout(flushGroupCommit, 250)
		},
		[flushGroupCommit],
	)

	const resetGroups = useCallback(async () => {
		if (inflightCommitRef.current !== null || pendingCommitRef.current) return
		setBulkBusy(true)
		try {
			const result = await management.catalog.updateLayout({ sections: null })
			if (result.ok === false) throw new Error(result.error)
			await refetchOverview()
			setDraftGroups(null)
			setOrganizerResetToken((n) => n + 1)
		} catch (error) {
			notify({ title: '恢复自动分组失败', message: runtimeErrorMessage(error), color: 'red' })
		} finally {
			setBulkBusy(false)
		}
	}, [management.catalog, notify, refetchOverview])

	useEffect(() => {
		return () => {
			if (commitTimerRef.current) window.clearTimeout(commitTimerRef.current)
		}
	}, [])

	const handleBulkAutoStart = useCallback(
		async (autoStart: boolean) => {
			if (selectedIds.length === 0) return
			const batch = selectedIds.map((id) => {
				const status = overview.statuses[id]
				if (!status) throw new Error(`Unknown catalog plugin id: ${id}`)
				return status
			})
			const displayNameByAddress = new Map(
				batch.map((status) => [pluginNodeIndexKey(status.address), status.name ?? status.id]),
			)
			setBulkBusy(true)
			try {
				const results = await setPluginAutoStarts(
					management,
					queryClient,
					batch.map(({ address }) => ({ address, autoStart })),
				)
				const failed = results.filter((r) => !r.ok)
				if (failed.length > 0) {
					notify({
						title: '操作完成但部分失败',
						message:
							failed
								.map((result) => displayNameByAddress.get(pluginNodeIndexKey(result.address)))
								.filter(Boolean)
								.join('，') || '操作失败',
						color: 'red',
					})
				} else {
					notify({
						title: autoStart ? '已批量开启自动启动' : '已批量关闭自动启动',
						message: (
							<Group gap={6} align="center" wrap="nowrap">
								<Box component="span">{batch.length} 个 Plugin 的当前会话状态保持不变</Box>
								<ActionIcon
									size="sm"
									variant="subtle"
									title="恢复原自动启动策略"
									aria-label="恢复原自动启动策略"
									onClick={() => {
										void (async () => {
											setBulkBusy(true)
											try {
												const undoResults = await setPluginAutoStarts(
													management,
													queryClient,
													batch.map(({ address, autoStart: previousAutoStart }) => ({
														address,
														autoStart: previousAutoStart,
													})),
												)
												const undoFailed = undoResults.filter((result) => !result.ok)
												if (undoFailed.length > 0) {
													notify({
														title: '部分策略恢复失败',
														message:
															undoFailed
																.map((result) =>
																	displayNameByAddress.get(pluginNodeIndexKey(result.address)),
																)
																.filter(Boolean)
																.join('，') || '恢复失败',
														color: 'red',
													})
												} else {
													notify({
														title: '已恢复原策略',
														message: `${batch.length} 个 Plugin 的自动启动策略已恢复`,
														color: 'green',
													})
												}
											} catch (error: unknown) {
												notify({
													title: '恢复失败',
													message: runtimeErrorMessage(error, '恢复失败，请稍后重试。'),
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
						autoClose: 5000,
					})
				}
			} catch (error: unknown) {
				notify({
					title: '操作失败',
					message: runtimeErrorMessage(error, '批量操作失败，请稍后重试。'),
					color: 'red',
				})
			} finally {
				setBulkBusy(false)
			}
		},
		[management, selectedIds, notify, overview.statuses, queryClient],
	)

	const handleBulkAction = useCallback(
		(action: BulkAction) => {
			if (action === 'clear') {
				setSelectedIds([])
				return
			}
			void handleBulkAutoStart(action === 'auto-start-on')
		},
		[handleBulkAutoStart],
	)

	// —— 视图渲染 —— //
	const loading = !overviewState.hasSnapshot && overviewState.isLoading
	const syncing = overviewState.hasSnapshot && overviewState.isLoading
	const errorMessage = !overviewState.hasSnapshot ? overviewState.error : undefined
	const filterQuery = deferredSearch
	const groupsForView = draftGroups ?? overview.groups
	const searchTokens = useMemo(() => parseSearchTokens(filterQuery), [filterQuery])
	const hasStatusFilter = hasActiveStatusFilter(statusFilter)

	// 搜索过程中的过渡状态，用于降低视觉闪烁
	const isTransitioning = search.trim() !== deferredSearch
	const hasAnyMatch = useMemo(() => {
		const hasQuery = hasActiveSearchTokens(searchTokens)
		if (!hasQuery && !hasStatusFilter) return true

		for (const group of groupsForView) {
			if (group.name && matchesGroupSearch(group.name, searchTokens)) return true
		}

		for (const [pid, st] of Object.entries(overview.statuses)) {
			if (matchesPluginSearch(pid, st, searchTokens, statusFilter)) return true
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
				onRetry={() => void refetchOverview()}
				minHeight={160}
			/>
		)
	} else if (overview.total === 0) {
		content = (
			<EmptyState
				icon={<IconPlugConnected size={28} stroke={1.5} />}
				title="暂无插件"
				description="安装插件后，这里会显示所有可用的插件列表。"
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
				activeId={pluginRoute}
				onGroupsChange={handleGroupsChange}
				onResetGroups={() => {
					void resetGroups()
				}}
				selectedIds={selectedIds}
				onSelectedIdsChange={setSelectedIds}
				filterQuery={filterQuery}
				statusFilter={statusFilter}
				LinkComponent={RouterLinkAdapter}
				density="ultra"
				locked={syncing || bulkBusy || layoutSaving}
			/>
		)
	}

	return (
		<Stack className="plx-pluginCatalog" w="100%">
			<div className="plx-pluginCatalog__header">
				<div className="plx-pluginCatalog__titleLine">
					<span className="plx-workbench__eyebrow">Plugins</span>
					<span className="plx-workbench__title">插件导览</span>
					{overview.total > 0 ? (
						<span
							className="plx-pluginCatalog__titleCount"
							title={`共 ${overview.total} 个插件`}
							aria-label={`共 ${overview.total} 个插件`}
							aria-live="polite"
						>
							{overview.total}
						</span>
					) : null}
				</div>
				<div className="plx-pluginCatalog__headerActions">
					<button
						type="button"
						className="plx-pluginCatalog__helpButton"
						onClick={() => setHelpOpened(true)}
						title="F1 / ? 打开快捷键和搜索语法"
					>
						<IconKeyboard size={13} stroke={1.8} />
						<span>F1</span>
					</button>
					{onCollapse ? (
						<button
							type="button"
							className="plx-workbench__iconButton"
							aria-label="收起插件列表"
							onClick={onCollapse}
						>
							<IconChevronLeft size={16} stroke={1.8} />
						</button>
					) : null}
				</div>
			</div>
			<div className="plx-pluginCatalog__toolbar">
				<SearchBar
					value={search}
					onChange={handleSearchChange}
					inputRef={inputRef}
					statusFilter={statusFilter}
					statusCounts={overview.statusCounts}
					onToggleStatus={toggleStatusFilter}
					onResetStatusFilter={resetStatusFilter}
					hasActiveStatusFilter={hasStatusFilter}
				/>
			</div>

			{selectedIds.length > 0 ? (
				<BulkActionsBar count={selectedIds.length} busy={bulkBusy} onAction={handleBulkAction} />
			) : null}

			<Box className="plx-pluginCatalog__body">
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

			<CatalogHelpModal opened={helpOpened} onClose={() => setHelpOpened(false)} />
		</Stack>
	)
}
