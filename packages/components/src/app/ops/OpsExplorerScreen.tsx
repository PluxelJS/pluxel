import { Text } from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import type { OpsToolsetInput, RuntimeOpCatalogEntry } from '@pluxel/runtime/web'

import { ErrorState } from '../../components'
import { rpcErrorMessage, useRuntimeTransportClient } from '../../runtime'
import { useNotify, useRuntimeOpCatalog, useRuntimeOpsToolsets } from '../hooks'
import {
	DEFAULT_OPS_WORKBENCH_CONTENT_LAYOUT,
	DEFAULT_OPS_WORKBENCH_HORIZONTAL_LAYOUT,
	OPS_WORKBENCH_CATALOG_PANEL_ID,
	OPS_WORKBENCH_CONTENT_LAYOUT_SCOPE,
	OPS_WORKBENCH_HORIZONTAL_LAYOUT_SCOPE,
	OPS_WORKBENCH_INSPECTOR_PANEL_ID,
	OPS_WORKBENCH_MAIN_PANEL_ID,
	OPS_WORKBENCH_PANELS_SCOPE,
	OPS_WORKBENCH_SIDEBAR_PANEL_ID,
	resolveOpsWorkbenchContentLayout,
	resolveOpsWorkbenchHorizontalLayout,
	resolveOpsWorkbenchPanelsState,
	sanitizeOpsWorkbenchContentLayout,
	sanitizeOpsWorkbenchHorizontalLayout,
	WorkbenchSplitView,
	type SplitViewHandle,
	usePatchedWorkbenchTabState,
	useSyncedLayout,
	useWorkbenchSplitLayout,
} from '../workbench/split'
import { AssignOpsToToolsetsModal } from './AssignOpsToToolsetsModal'
import { OpsCatalogPane } from './components/OpsCatalogPane'
import { OpsInspectorPane } from './components/OpsInspectorPane'
import { OpsSidebarPane } from './components/OpsSidebarPane'
import { ToolsetDialog } from './components/ToolsetDialog'
import {
	buildOpsExplorerCatalogView,
	buildOpsExplorerSidebarData,
	buildOpsToolsetMembershipMap,
	buildOpsToolsetSummaries,
	createInitialRuntimeOpInput,
	createOpsToolsetId,
	getRuntimeOpInputMode,
	normalizeOpsToolsetName,
	type OpsExplorerSelection,
} from './model'
import type { RunResult, ToolsetDialogState } from './types'
import { renderResult } from './view'

export function OpsExplorerScreen() {
	const transport = useRuntimeTransportClient()
	const notify = useNotify()
	const catalogState = useRuntimeOpCatalog()
	const toolsetsState = useRuntimeOpsToolsets()
	const horizontalGroupRef = useRef<SplitViewHandle | null>(null)
	const contentGroupRef = useRef<SplitViewHandle | null>(null)

	const [selection, setSelection] = useState<OpsExplorerSelection>({ kind: 'all' })
	const [search, setSearch] = useState('')
	const [selectedOpIds, setSelectedOpIds] = useState<string[]>([])
	const [activeEntryId, setActiveEntryId] = useState<string | null>(null)
	const [preparedEntryId, setPreparedEntryId] = useState<string | null>(null)
	const [busyId, setBusyId] = useState<string | null>(null)
	const [drafts, setDrafts] = useState<Record<string, string>>({})
	const [results, setResults] = useState<Record<string, RunResult>>({})
	const [toolsetDialog, setToolsetDialog] = useState<ToolsetDialogState>({ mode: 'closed' })
	const [toolsetNameDraft, setToolsetNameDraft] = useState('')
	const [toolsetDescriptionDraft, setToolsetDescriptionDraft] = useState('')
	const [assignModalOpIds, setAssignModalOpIds] = useState<string[]>([])
	const deferredSearch = useDeferredValue(search)

	const entries = catalogState.data ?? []
	const toolsets = toolsetsState.data ?? []
	const entriesById = useMemo(() => new Map(entries.map((entry) => [entry.id, entry])), [entries])
	const selectedOpIdSet = useMemo(() => new Set(selectedOpIds), [selectedOpIds])
	const sidebar = useMemo(() => buildOpsExplorerSidebarData(entries), [entries])
	const toolsetSummaries = useMemo(() => buildOpsToolsetSummaries(toolsets, entries), [entries, toolsets])
	const toolsetsByOpId = useMemo(() => buildOpsToolsetMembershipMap(toolsets), [toolsets])
	const [{ inspectorVisible, sidebarVisible }, setPanelsState] = usePatchedWorkbenchTabState(
		OPS_WORKBENCH_PANELS_SCOPE,
		resolveOpsWorkbenchPanelsState,
	)
	const [horizontalLayout, handleHorizontalLayoutChanged] = useWorkbenchSplitLayout(
		OPS_WORKBENCH_HORIZONTAL_LAYOUT_SCOPE,
		resolveOpsWorkbenchHorizontalLayout,
		sanitizeOpsWorkbenchHorizontalLayout,
	)
	const [contentLayout, handleContentLayoutChanged] = useWorkbenchSplitLayout(
		OPS_WORKBENCH_CONTENT_LAYOUT_SCOPE,
		resolveOpsWorkbenchContentLayout,
		sanitizeOpsWorkbenchContentLayout,
	)

	const ungroupedCount = useMemo(
		() => entries.filter((entry) => !toolsetsByOpId.has(entry.id)).length,
		[entries, toolsetsByOpId],
	)
	const selectedToolset =
		selection.kind === 'toolset'
			? toolsets.find((toolset) => toolset.toolsetId === selection.toolsetId) ?? null
			: null
	const catalogView = useMemo(
		() =>
			buildOpsExplorerCatalogView(entries, {
				selection,
				search: deferredSearch,
				toolsets,
			}),
		[deferredSearch, entries, selection, toolsets],
	)
	const visibleEntries = catalogView.entries
	const visibleEntryIds = useMemo(() => visibleEntries.map((entry) => entry.id), [visibleEntries])
	const visibleIdSet = useMemo(() => new Set(visibleEntryIds), [visibleEntryIds])

	useEffect(() => {
		if (selection.kind !== 'toolset') return
		if (toolsets.some((toolset) => toolset.toolsetId === selection.toolsetId)) return
		setSelection({ kind: 'all' })
	}, [selection, toolsets])

	useEffect(() => {
		if (selection.kind !== 'owner') return
		if (sidebar.owners.some((owner) => owner.owner === selection.owner)) return
		setSelection({ kind: 'all' })
	}, [selection, sidebar.owners])

	useEffect(() => {
		setSelectedOpIds((current) => current.filter((opId) => entriesById.has(opId)))
	}, [entriesById])

	useEffect(() => {
		if (visibleEntries.length === 0) {
			setActiveEntryId(null)
			setPreparedEntryId(null)
			return
		}
		if (activeEntryId && visibleIdSet.has(activeEntryId)) return
		setActiveEntryId(visibleEntries[0]?.id ?? null)
		setPreparedEntryId(null)
	}, [activeEntryId, visibleEntries, visibleIdSet])

	const activeEntry = activeEntryId ? entriesById.get(activeEntryId) ?? null : null
	const activeToolsets = activeEntry ? toolsetsByOpId.get(activeEntry.id) ?? [] : []
	const activeResult = activeEntry ? results[activeEntry.id] : undefined
	const activeInputMode = activeEntry ? getRuntimeOpInputMode(activeEntry) : 'unsupported'
	const activeDraft =
		activeEntry ? drafts[activeEntry.id] ?? createInitialRuntimeOpInput(activeEntry) : ''
	const visibleSelectionCount = visibleEntryIds.filter((id) => selectedOpIdSet.has(id)).length
	const allVisibleSelected = visibleEntryIds.length > 0 && visibleSelectionCount === visibleEntryIds.length
	const indeterminate = visibleSelectionCount > 0 && !allVisibleSelected
	const selectedCount = selectedOpIds.length
	const syncing = catalogState.loading || toolsetsState.loading || toolsetsState.saving
	const emptyCatalogDescription =
		selection.kind === 'toolset' && selectedToolset?.opIds.length === 0
			? '这个 toolset 还是空的。先在其它视图里多选 ops，再加入这个 toolset。'
			: '当前筛选下没有命中的 RPC ops。'

	const toggleSidebar = useCallback(() => {
		setPanelsState({ sidebarVisible: !sidebarVisible })
	}, [setPanelsState, sidebarVisible])
	const toggleInspector = useCallback(() => {
		setPanelsState({ inspectorVisible: !inspectorVisible })
	}, [inspectorVisible, setPanelsState])

	useSyncedLayout(horizontalGroupRef, horizontalLayout, sidebarVisible)
	useSyncedLayout(contentGroupRef, contentLayout, inspectorVisible)

	const persistToolsets = async (
		nextToolsets: OpsToolsetInput[],
		options?: { successTitle?: string; successMessage?: string },
	) => {
		try {
			const saved = await toolsetsState.update(nextToolsets)
			if (options?.successTitle) {
				notify({
					title: options.successTitle,
					message: options.successMessage ?? '',
					color: 'green',
				})
			}
			return saved
		} catch (error) {
			const message = rpcErrorMessage(error, '保存 toolset 失败')
			notify({
				title: '保存失败',
				message,
				color: 'red',
			})
			throw error
		}
	}

	function prepareEntry(entry: RuntimeOpCatalogEntry) {
		setActiveEntryId(entry.id)
		if (getRuntimeOpInputMode(entry) !== 'json-object') return
		setPreparedEntryId(entry.id)
		setDrafts((prev) =>
			prev[entry.id] !== undefined
				? prev
				: { ...prev, [entry.id]: createInitialRuntimeOpInput(entry) },
		)
	}

	async function runEntry(entry: RuntimeOpCatalogEntry) {
		setActiveEntryId(entry.id)
		const mode = getRuntimeOpInputMode(entry)
		if (mode === 'unsupported') {
			notify({
				title: '暂不支持执行',
				message: '当前 UI 只支持 object input op。',
				color: 'yellow',
			})
			return
		}
		if (mode === 'json-object' && preparedEntryId !== entry.id) {
			prepareEntry(entry)
			return
		}

		const execute = async () => {
			setBusyId(entry.id)
			try {
				const rawDraft = drafts[entry.id] ?? createInitialRuntimeOpInput(entry)
				const payload =
					mode === 'none'
						? {}
						: rawDraft.trim().length === 0
							? {}
							: JSON.parse(rawDraft)
				const value = await transport.withRpc((rpc) => rpc.opsInvoke(entry.id, payload))
				setResults((prev) => ({
					...prev,
					[entry.id]: { ok: true, text: renderResult(value), at: Date.now() },
				}))
				if (preparedEntryId === entry.id) setPreparedEntryId(null)
				notify({
					title: 'Op 执行完成',
					message: entry.descriptor.doc.title ?? entry.id,
					color: 'green',
				})
			} catch (invokeError) {
				const message = rpcErrorMessage(invokeError, '执行失败')
				setResults((prev) => ({
					...prev,
					[entry.id]: { ok: false, text: message, at: Date.now() },
				}))
				notify({
					title: 'Op 执行失败',
					message,
					color: 'red',
				})
			} finally {
				setBusyId(null)
			}
		}

		if (entry.workbench.confirm) {
			openConfirmModal({
				title: '确认执行操作',
				children: (
					<Text size="sm" c="dimmed">
						{entry.descriptor.doc.description ?? entry.id}
					</Text>
				),
				labels: { confirm: '执行', cancel: '取消' },
				confirmProps: { color: 'orange' },
				onConfirm: () => {
					void execute()
				},
			})
			return
		}

		await execute()
	}

	function setRowSelected(opId: string, checked: boolean) {
		setSelectedOpIds((current) =>
			checked ? Array.from(new Set([...current, opId])) : current.filter((id) => id !== opId),
		)
	}

	function toggleSelectAllVisible(checked: boolean) {
		setSelectedOpIds((current) => {
			if (checked) return Array.from(new Set([...current, ...visibleEntryIds]))
			return current.filter((id) => !visibleIdSet.has(id))
		})
	}

	function openCreateToolsetDialog() {
		setToolsetDialog({ mode: 'create' })
		setToolsetNameDraft('')
		setToolsetDescriptionDraft('')
	}

	function openRenameToolsetDialog() {
		if (!selectedToolset) return
		setToolsetDialog({ mode: 'rename', toolsetId: selectedToolset.toolsetId })
		setToolsetNameDraft(selectedToolset.name)
		setToolsetDescriptionDraft(selectedToolset.description ?? '')
	}

	const closeToolsetDialog = () => {
		if (toolsetsState.saving) return
		setToolsetDialog({ mode: 'closed' })
		setToolsetNameDraft('')
		setToolsetDescriptionDraft('')
	}

	const submitToolsetDialog = async () => {
		const name = normalizeOpsToolsetName(toolsetNameDraft)
		if (!name) {
			notify({
				title: 'Toolset 名不能为空',
				message: '请输入一个可读的名称。',
				color: 'yellow',
			})
			return
		}

		if (toolsetDialog.mode === 'create') {
			const toolsetId = createOpsToolsetId()
			await persistToolsets(
				[
					...toolsets,
					{
						toolsetId,
						name,
						description: normalizeOpsToolsetName(toolsetDescriptionDraft) || undefined,
						opIds: [],
					},
				],
				{ successTitle: '已创建 Toolset', successMessage: name },
			)
			setSelection({ kind: 'toolset', toolsetId })
			closeToolsetDialog()
			return
		}

		if (toolsetDialog.mode === 'rename') {
			await persistToolsets(
				toolsets.map((toolset) =>
					toolset.toolsetId === toolsetDialog.toolsetId
						? {
								...toolset,
								name,
								description: normalizeOpsToolsetName(toolsetDescriptionDraft) || undefined,
						  }
						: toolset,
				),
				{ successTitle: '已重命名 Toolset', successMessage: name },
			)
			closeToolsetDialog()
		}
	}

	function deleteSelectedToolset() {
		if (!selectedToolset) return
		openConfirmModal({
			title: '删除 Toolset',
			children: (
				<Text size="sm" c="dimmed">
					删除后只会移除宿主侧 toolset 元数据，不会影响 registry 本身。
				</Text>
			),
			labels: { confirm: '删除', cancel: '取消' },
			confirmProps: { color: 'red' },
			onConfirm: async () => {
				await persistToolsets(
					toolsets.filter((toolset) => toolset.toolsetId !== selectedToolset.toolsetId),
					{ successTitle: '已删除 Toolset', successMessage: selectedToolset.name },
				)
				setSelection({ kind: 'all' })
			},
		})
	}

	const saveAssignedToolsets = async (
		nextToolsets: OpsToolsetInput[],
		options?: { successTitle?: string; successMessage?: string },
	) => {
		await persistToolsets(nextToolsets, options)
		setAssignModalOpIds([])
	}

	if (catalogState.error && !catalogState.data) {
		return (
			<ErrorState
				withBorder
				minHeight={260}
				message={catalogState.error.message}
				onRetry={() => {
					void catalogState.refetch()
				}}
			/>
		)
	}

	if (toolsetsState.error && !toolsetsState.data) {
		return (
			<ErrorState
				withBorder
				minHeight={260}
				message={toolsetsState.error.message}
				onRetry={() => {
					void toolsetsState.refetch()
				}}
			/>
		)
	}

	return (
		<>
			<div className="plx-opsScreen">
				<WorkbenchSplitView
					ref={horizontalGroupRef}
					className="plx-opsScreen__outer"
					defaultLayout={horizontalLayout}
					id="pluxel-ops-workbench-horizontal"
					onLayoutChanged={sidebarVisible ? handleHorizontalLayoutChanged : undefined}
					orientation="horizontal"
					primary={{
						id: OPS_WORKBENCH_SIDEBAR_PANEL_ID,
						defaultSize:
							horizontalLayout[OPS_WORKBENCH_SIDEBAR_PANEL_ID] ??
							DEFAULT_OPS_WORKBENCH_HORIZONTAL_LAYOUT[OPS_WORKBENCH_SIDEBAR_PANEL_ID],
						minSize: 14,
						snap: true,
						visible: sidebarVisible,
						onVisibleChange: (visible) => {
							setPanelsState({ sidebarVisible: visible })
						},
						children: (
							<div className="plx-opsScreen__sidebar">
								<OpsSidebarPane
									onCreateToolset={openCreateToolsetDialog}
									onSelect={setSelection}
									selection={selection}
									sidebar={sidebar}
									toolsetSummaries={toolsetSummaries}
									ungroupedCount={ungroupedCount}
								/>
							</div>
						),
					}}
					secondary={{
						id: OPS_WORKBENCH_MAIN_PANEL_ID,
						defaultSize:
							horizontalLayout[OPS_WORKBENCH_MAIN_PANEL_ID] ??
							DEFAULT_OPS_WORKBENCH_HORIZONTAL_LAYOUT[OPS_WORKBENCH_MAIN_PANEL_ID],
						minSize: 48,
						children: (
							<WorkbenchSplitView
								ref={contentGroupRef}
								className="plx-opsScreen__inner"
								defaultLayout={contentLayout}
								id="pluxel-ops-workbench-content"
								onLayoutChanged={inspectorVisible ? handleContentLayoutChanged : undefined}
								orientation="horizontal"
								primary={{
									id: OPS_WORKBENCH_CATALOG_PANEL_ID,
									defaultSize:
										contentLayout[OPS_WORKBENCH_CATALOG_PANEL_ID] ??
										DEFAULT_OPS_WORKBENCH_CONTENT_LAYOUT[OPS_WORKBENCH_CATALOG_PANEL_ID],
									minSize: 36,
									children: (
										<div className="plx-opsScreen__catalog">
											<OpsCatalogPane
												activeEntryId={activeEntryId}
												allVisibleSelected={allVisibleSelected}
												busyId={busyId}
												emptyCatalogDescription={emptyCatalogDescription}
												indeterminate={indeterminate}
												inspectorVisible={inspectorVisible}
												onAssignSelection={() => setAssignModalOpIds(selectedOpIds)}
												onClearSelection={() => setSelectedOpIds([])}
												onOpenAssignModal={setAssignModalOpIds}
												onRefresh={() => {
													void Promise.all([catalogState.refetch(), toolsetsState.refetch()])
												}}
												onRenameToolset={openRenameToolsetDialog}
												onRowSelectionChange={setRowSelected}
												onRunEntry={runEntry}
												onSearchChange={setSearch}
												onSelectEntry={setActiveEntryId}
												onSelectVisibleChange={toggleSelectAllVisible}
												onToggleInspector={toggleInspector}
												onToggleSidebar={toggleSidebar}
												onToolsetDelete={deleteSelectedToolset}
												results={results}
												search={search}
												selectedCount={selectedCount}
												selectedOpIdSet={selectedOpIdSet}
												selectedToolset={selectedToolset}
												selection={selection}
												showToolsetError={Boolean(toolsetsState.error && toolsetsState.data)}
												sidebarVisible={sidebarVisible}
												syncing={syncing}
												toolsetErrorMessage={toolsetsState.error?.message}
												toolsetsByOpId={toolsetsByOpId}
												visibleEntries={visibleEntries}
											/>
										</div>
									),
								}}
								secondary={{
									id: OPS_WORKBENCH_INSPECTOR_PANEL_ID,
									defaultSize:
										contentLayout[OPS_WORKBENCH_INSPECTOR_PANEL_ID] ??
										DEFAULT_OPS_WORKBENCH_CONTENT_LAYOUT[OPS_WORKBENCH_INSPECTOR_PANEL_ID],
									minSize: 18,
									snap: true,
									visible: inspectorVisible,
									onVisibleChange: (visible) => {
										setPanelsState({ inspectorVisible: visible })
									},
									children: (
										<div className="plx-opsScreen__inspector">
											<OpsInspectorPane
												activeDraft={activeDraft}
												activeEntry={activeEntry}
												activeInputMode={activeInputMode}
												activeResult={activeResult}
												activeToolsets={activeToolsets}
												busyId={busyId}
												catalogMissingOpIds={catalogView.missingOpIds}
												onAssignToolsets={setAssignModalOpIds}
												onCancelPrepared={() => setPreparedEntryId(null)}
												onDraftChange={(value) => {
													if (!activeEntry) return
													setDrafts((prev) => ({ ...prev, [activeEntry.id]: value }))
												}}
												onPrepareEntry={prepareEntry}
												onRunEntry={runEntry}
												preparedEntryId={preparedEntryId}
												selection={selection}
											/>
										</div>
									),
								}}
							/>
						),
					}}
				/>
			</div>

			<ToolsetDialog
				description={toolsetDescriptionDraft}
				name={toolsetNameDraft}
				onClose={closeToolsetDialog}
				onDescriptionChange={setToolsetDescriptionDraft}
				onNameChange={setToolsetNameDraft}
				onSubmit={() => {
					void submitToolsetDialog()
				}}
				saving={toolsetsState.saving}
				state={toolsetDialog}
			/>

			{assignModalOpIds.length > 0 ? (
				<AssignOpsToToolsetsModal
					opened
					opIds={assignModalOpIds}
					toolsets={toolsets}
					saving={toolsetsState.saving}
					onClose={() => setAssignModalOpIds([])}
					onSave={(nextGroups, options) => {
						void saveAssignedToolsets(nextGroups, options)
					}}
				/>
			) : null}
		</>
	)
}
