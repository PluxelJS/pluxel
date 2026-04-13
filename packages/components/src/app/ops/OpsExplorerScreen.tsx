import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Code,
	Group,
	Modal,
	NavLink,
	Paper,
	Stack,
	Table,
	Text,
	TextInput,
	Textarea,
} from '@mantine/core'
import { openConfirmModal } from '@mantine/modals'
import {
	IconPencil,
	IconPlayerPlay,
	IconPlus,
	IconRefresh,
	IconSearch,
	IconStack2,
	IconTool,
	IconTrash,
	IconX,
} from '@tabler/icons-react'
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from 'react'
import type { OpsToolsetInput, RuntimeOpCatalogEntry } from '@pluxel/runtime/web'

import { EmptyState, ErrorState, InlineNotice } from '../../components'
import { rpcErrorMessage, useRuntimeTransportClient } from '../../runtime'
import { useNotify, useRuntimeOpCatalog, useRuntimeOpsToolsets } from '../hooks'
import { AssignOpsToToolsetsModal } from './AssignOpsToToolsetsModal'
import {
	buildOpsExplorerCatalogView,
	buildOpsExplorerSidebarData,
	buildOpsToolsetMembershipMap,
	buildOpsToolsetSummaries,
	createInitialRuntimeOpInput,
	createOpsToolsetId,
	getRuntimeOpInputMode,
	getOwnerLabel,
	normalizeOpsToolsetName,
	type OpsExplorerSelection,
} from './model'

type ToolsetDialogState =
	| { mode: 'closed' }
	| { mode: 'create' }
	| { mode: 'rename'; toolsetId: string }

type RunResult = {
	ok: boolean
	text: string
	at: number
}

function OpsPanel({
	header,
	children,
}: {
	header: ReactNode
	children: ReactNode
}) {
	return (
		<Paper withBorder radius="md" shadow="xs" className="plx-opsPanel">
			<div className="plx-opsPanel__header">{header}</div>
			<div className="plx-opsPanel__body">{children}</div>
		</Paper>
	)
}

function OpsPanelScroll({ children }: { children: ReactNode }) {
	return <div className="plx-opsPanel__scroll">{children}</div>
}

function OpsSidebarSectionTitle({ children }: { children: ReactNode }) {
	return (
		<Text size="xs" fw={700} c="dimmed" tt="uppercase" mt="sm" px="sm">
			{children}
		</Text>
	)
}

function OpsPanelEmpty({
	title,
	description,
}: {
	title: string
	description: string
}) {
	return (
		<div className="plx-opsPanel__empty">
			<EmptyState
				withBorder
				minHeight={320}
				icon={<IconTool size={24} />}
				title={title}
				description={description}
			/>
		</div>
	)
}

function OpsRunResultCard({ result }: { result: RunResult }) {
	const tone = result.ok ? 'success' : 'error'
	return (
		<Paper radius="md" p="sm" className={`plx-opsResultCard plx-opsResultCard--${tone}`}>
			<Stack gap={6}>
				<Group justify="space-between" align="center">
					<Text size="xs" fw={700} className={`plx-opsResultCard__label--${tone}`}>
						{result.ok ? '最近结果' : '最近错误'}
					</Text>
					<Text size="xs" c="dimmed">
						{formatRunStamp(result.at)}
					</Text>
				</Group>
				<pre className={`plx-opsResultCard__content plx-opsResultCard__content--${tone}`}>
					{result.text}
				</pre>
			</Stack>
		</Paper>
	)
}

function OpsSelectionActions({
	selectedCount,
	onAssign,
	onClear,
}: {
	selectedCount: number
	onAssign: () => void
	onClear: () => void
}) {
	const disabled = selectedCount === 0
	return (
		<Group gap={6} wrap="nowrap">
			<Badge size="xs" color={disabled ? 'gray' : 'brand'} variant="filled">
				{selectedCount}
			</Badge>
			<Button
				size="compact-xs"
				variant="light"
				leftSection={<IconStack2 size={12} />}
				disabled={disabled}
				onClick={onAssign}
			>
				加入 Toolset
			</Button>
			<ActionIcon
				variant="subtle"
				color="gray"
				disabled={disabled}
				onClick={onClear}
				title="清空当前选择"
				aria-label="清空当前选择"
			>
				<IconX size={16} />
			</ActionIcon>
		</Group>
	)
}

function renderResult(value: unknown): string {
	if (typeof value === 'string') return value
	try {
		return JSON.stringify(value, null, 2)
	} catch {
		return String(value)
	}
}

function getRunTone(entry: RuntimeOpCatalogEntry): 'brand' | 'orange' {
	return entry.descriptor.policy.mutating || entry.descriptor.policy.confirm ? 'orange' : 'brand'
}

function getOwnerDisplay(entry: RuntimeOpCatalogEntry): string {
	return entry.ownerKind === 'plugin' ? getOwnerLabel(entry.owner) : entry.owner
}

function selectionLabel(selection: OpsExplorerSelection, toolsetName?: string): string {
	switch (selection.kind) {
		case 'all':
			return '全部 Ops'
		case 'toolset':
			return toolsetName ?? 'Toolset'
		case 'ungrouped':
			return '未归组'
		case 'runtime':
			return '宿主 Ops'
		case 'owner':
			return selection.owner.startsWith('plugin:')
				? selection.owner.slice('plugin:'.length)
				: selection.owner
	}
}

function selectionDescription(selection: OpsExplorerSelection): string {
	switch (selection.kind) {
		case 'all':
			return '全量 live registry 工作台，可搜索、批量编组和执行。'
		case 'toolset':
			return '宿主侧 toolset，适合保存跨插件的常用工具组合与用途描述。'
		case 'ungrouped':
			return '当前还未纳入任何 toolset 的 ops。'
		case 'runtime':
			return '宿主 runtime 提供的 canonical control-plane ops。'
		case 'owner':
			return '按插件 owner 聚焦浏览当前命中的 ops。'
	}
}

function formatRunStamp(at: number): string {
	try {
		return new Intl.DateTimeFormat('zh-CN', {
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		}).format(at)
	} catch {
		return new Date(at).toLocaleTimeString()
	}
}

function getToolsetSummaryDescription(summary: {
	description?: string
	availableCount: number
	missingCount: number
}) {
	if (summary.description) return summary.description
	if (summary.missingCount > 0) {
		return `${summary.availableCount} 可用 · ${summary.missingCount} 缺失`
	}
	return `${summary.availableCount} 个 op`
}

export function OpsExplorerScreen() {
	const transport = useRuntimeTransportClient()
	const notify = useNotify()
	const catalogState = useRuntimeOpCatalog()
	const toolsetsState = useRuntimeOpsToolsets()

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

	const sidebarPane = (
		<OpsPanel
			header={
				<Group justify="space-between" align="flex-start" wrap="nowrap">
					<Stack gap={4}>
						<Text fw={700} size="sm">
							Ops Toolsets
						</Text>
						<Text size="xs" c="dimmed">
							先选 op，再把常用组合保存成 toolset。
						</Text>
					</Stack>
					<ActionIcon
						variant="light"
						color="brand"
						onClick={openCreateToolsetDialog}
						title="新建空 Toolset"
						aria-label="新建空 Toolset"
					>
						<IconPlus size={16} />
					</ActionIcon>
				</Group>
			}
		>
			<OpsPanelScroll>
				<Stack gap={4} p="xs">
					<NavLink
						active={selection.kind === 'all'}
						label="全部"
						description="全量 live ops"
						rightSection={<Badge size="xs">{sidebar.counts.all}</Badge>}
						onClick={() => setSelection({ kind: 'all' })}
					/>
					<NavLink
						active={selection.kind === 'ungrouped'}
						label="未归组"
						description="还没进任何 toolset"
						rightSection={<Badge size="xs">{ungroupedCount}</Badge>}
						onClick={() => setSelection({ kind: 'ungrouped' })}
					/>
					<NavLink
						active={selection.kind === 'runtime'}
						label="宿主"
						description="runtime canonical ops"
						rightSection={<Badge size="xs">{sidebar.counts.runtime}</Badge>}
						onClick={() => setSelection({ kind: 'runtime' })}
					/>

					<OpsSidebarSectionTitle>Toolsets</OpsSidebarSectionTitle>
					{toolsetSummaries.length === 0 ? (
						<Text size="xs" c="dimmed" px="sm" py={6}>
							还没有 toolset。先在列表里选中几个 op，再批量加入更顺手。
						</Text>
					) : (
						toolsetSummaries.map((toolset) => (
							<NavLink
								key={toolset.toolsetId}
								active={selection.kind === 'toolset' && selection.toolsetId === toolset.toolsetId}
								label={toolset.name}
								description={getToolsetSummaryDescription(toolset)}
								rightSection={<Badge size="xs">{toolset.availableCount}</Badge>}
								onClick={() => setSelection({ kind: 'toolset', toolsetId: toolset.toolsetId })}
							/>
						))
					)}

					<OpsSidebarSectionTitle>插件 Owners</OpsSidebarSectionTitle>
					{sidebar.owners.length === 0 ? (
						<Text size="xs" c="dimmed" px="sm" py={6}>
							当前没有插件级 ops
						</Text>
					) : (
						sidebar.owners.map((owner) => (
							<NavLink
								key={owner.owner}
								active={selection.kind === 'owner' && selection.owner === owner.owner}
								label={owner.label}
								description={owner.owner}
								rightSection={<Badge size="xs">{owner.count}</Badge>}
								onClick={() => setSelection({ kind: 'owner', owner: owner.owner })}
							/>
						))
					)}
				</Stack>
			</OpsPanelScroll>
		</OpsPanel>
	)

	const catalogPane = (
		<OpsPanel
			header={
				<Stack gap="sm">
					<Group justify="space-between" align="center" wrap="nowrap">
						<div>
							<Text fw={700} size="sm">
								{selectionLabel(selection, selectedToolset?.name)}
							</Text>
							<Text size="xs" c="dimmed">
								{selectionDescription(selection)}
							</Text>
						</div>
						<Group gap={6} wrap="nowrap">
							{selectedToolset ? (
								<>
									<ActionIcon
										variant="subtle"
										color="gray"
										onClick={openRenameToolsetDialog}
										title="重命名 Toolset"
										aria-label="重命名 Toolset"
									>
										<IconPencil size={16} />
									</ActionIcon>
									<ActionIcon
										variant="subtle"
										color="red"
										onClick={deleteSelectedToolset}
										title="删除 Toolset"
										aria-label="删除 Toolset"
									>
										<IconTrash size={16} />
									</ActionIcon>
								</>
							) : null}
							<OpsSelectionActions
								selectedCount={selectedCount}
								onAssign={() => setAssignModalOpIds(selectedOpIds)}
								onClear={() => setSelectedOpIds([])}
							/>
							{syncing ? (
								<Badge size="xs" variant="dot" color="brand">
									同步中
								</Badge>
							) : null}
							<ActionIcon
								variant="subtle"
								color="gray"
								title="刷新页面数据"
								aria-label="刷新页面数据"
								onClick={() => {
									void Promise.all([catalogState.refetch(), toolsetsState.refetch()])
								}}
							>
								<IconRefresh size={16} />
							</ActionIcon>
						</Group>
					</Group>

					<TextInput
						size="sm"
						leftSection={<IconSearch size={14} />}
						placeholder="搜索标题、描述、命令、输入字段"
						value={search}
						onChange={(event) => setSearch(event.currentTarget.value)}
					/>
				</Stack>
			}
		>
			<div className="plx-opsCatalog">
				<div className="plx-opsCatalog__meta">
					{toolsetsState.error && toolsetsState.data ? (
						<div className="plx-opsCatalog__notice">
							<InlineNotice title="Toolset 保存链路最近返回了错误">
								<Text size="sm" c="dimmed">
									{toolsetsState.error.message}
								</Text>
							</InlineNotice>
						</div>
					) : null}
				</div>

				<div className="plx-opsCatalog__list">
					{visibleEntries.length === 0 ? (
						<OpsPanelEmpty title="没有匹配的操作" description={emptyCatalogDescription} />
					) : (
						<div className="plx-opsCatalog__table">
							<Table striped highlightOnHover miw={720} verticalSpacing="xs" horizontalSpacing="sm">
								<Table.Thead>
									<Table.Tr>
										<Table.Th w={42}>
											<Checkbox
												checked={allVisibleSelected}
												indeterminate={indeterminate}
												onChange={(event) => toggleSelectAllVisible(event.currentTarget.checked)}
												aria-label="全选当前列表"
											/>
										</Table.Th>
										<Table.Th>操作</Table.Th>
										<Table.Th w={120}>Owner</Table.Th>
										<Table.Th w={180}>Toolsets</Table.Th>
										<Table.Th w={120}>最近结果</Table.Th>
										<Table.Th w={220}>动作</Table.Th>
									</Table.Tr>
								</Table.Thead>
								<Table.Tbody>
									{visibleEntries.map((entry) => {
										const run = results[entry.id]
										const rowToolsets = toolsetsByOpId.get(entry.id) ?? []
										return (
											<Table.Tr
												key={entry.id}
												data-active={activeEntryId === entry.id || undefined}
												className="plx-opsCatalog__row"
												onClick={() => setActiveEntryId(entry.id)}
											>
												<Table.Td onClick={(event) => event.stopPropagation()}>
													<Checkbox
														checked={selectedOpIdSet.has(entry.id)}
														onChange={(event) => setRowSelected(entry.id, event.currentTarget.checked)}
														aria-label={`选择 ${entry.id}`}
													/>
												</Table.Td>
												<Table.Td>
													<Stack gap={2}>
														<Group gap={6} wrap="wrap">
															<Text fw={600} size="sm">
																{entry.descriptor.doc.title ?? entry.id}
															</Text>
															{entry.descriptor.policy.confirm ? (
																<Badge size="xs" variant="dot" color="yellow">
																	确认
																</Badge>
															) : null}
														</Group>
														<Text size="xs" c="dimmed" lineClamp={2}>
															{entry.descriptor.doc.description ?? entry.id}
														</Text>
														<Code>{entry.id}</Code>
													</Stack>
												</Table.Td>
												<Table.Td>
													<Badge size="sm" variant="light" color="gray">
														{getOwnerDisplay(entry)}
													</Badge>
												</Table.Td>
												<Table.Td>
													{rowToolsets.length === 0 ? (
														<Text size="xs" c="dimmed">
															未归组
														</Text>
													) : (
														<Group gap={4} wrap="wrap">
															{rowToolsets.slice(0, 2).map((toolset) => (
																<Badge key={toolset.toolsetId} size="xs" variant="light" color="brand">
																	{toolset.name}
																</Badge>
															))}
															{rowToolsets.length > 2 ? (
																<Badge size="xs" variant="dot" color="gray">
																	+{rowToolsets.length - 2}
																</Badge>
															) : null}
														</Group>
													)}
												</Table.Td>
												<Table.Td>
													{run ? (
														<Stack gap={2}>
															<Badge size="xs" color={run.ok ? 'green' : 'red'} variant="light">
																{run.ok ? '成功' : '失败'}
															</Badge>
															<Text size="xs" c="dimmed">
																{formatRunStamp(run.at)}
															</Text>
														</Stack>
													) : (
														<Text size="xs" c="dimmed">
															未执行
														</Text>
													)}
												</Table.Td>
												<Table.Td onClick={(event) => event.stopPropagation()}>
													<Group gap={6} wrap="nowrap">
														<Button
															size="compact-xs"
															variant="light"
															leftSection={<IconStack2 size={12} />}
															onClick={() => setAssignModalOpIds([entry.id])}
														>
															Toolset
														</Button>
														<Button
															size="compact-xs"
															variant="filled"
															leftSection={<IconPlayerPlay size={12} />}
															color={getRunTone(entry)}
															loading={busyId === entry.id}
															disabled={busyId !== null && busyId !== entry.id}
															onClick={() => {
																void runEntry(entry)
															}}
														>
															执行
														</Button>
													</Group>
												</Table.Td>
											</Table.Tr>
										)
									})}
								</Table.Tbody>
							</Table>
						</div>
					)}
				</div>
			</div>
		</OpsPanel>
	)

	const inspectorPane = (
		<OpsPanel
			header={
				<>
					<Text fw={700} size="sm">
						Inspector
					</Text>
					<Text size="xs" c="dimmed">
						详情、执行输入和最近结果都集中在这里，不再撑大主列表。
					</Text>
				</>
			}
		>
			<OpsPanelScroll>
				{activeEntry ? (
					<Stack gap="sm" p="sm">
						<Stack gap={4}>
							<Text fw={700}>{activeEntry.descriptor.doc.title ?? activeEntry.id}</Text>
							<Text size="sm" c="dimmed">
								{activeEntry.descriptor.doc.description ?? activeEntry.id}
							</Text>
							<Group gap={6} wrap="wrap">
								<Code>{activeEntry.id}</Code>
								<Badge size="xs" variant="light" color="gray">
									{getOwnerDisplay(activeEntry)}
								</Badge>
								{activeEntry.descriptor.transports.tool ? (
									<Badge size="xs" variant="light" color="blue">
										Tool
									</Badge>
								) : null}
								{activeEntry.descriptor.transports.cli ? (
									<Badge size="xs" variant="light" color="gray">
										CLI
									</Badge>
								) : null}
							</Group>
						</Stack>

						<Paper withBorder radius="md" p="sm">
							<Stack gap={6}>
								<Text size="xs" fw={700} c="dimmed" tt="uppercase">
									Toolset 归属
								</Text>
								{activeToolsets.length === 0 ? (
									<Text size="sm" c="dimmed">
										当前未加入任何 toolset。
									</Text>
								) : (
									<Group gap={6} wrap="wrap">
										{activeToolsets.map((toolset) => (
											<Badge key={toolset.toolsetId} size="sm" variant="light" color="brand">
												{toolset.name}
											</Badge>
										))}
									</Group>
								)}
								<Button
									size="xs"
									variant="light"
									leftSection={<IconStack2 size={14} />}
									onClick={() => setAssignModalOpIds([activeEntry.id])}
								>
									管理 Toolset
								</Button>
							</Stack>
						</Paper>

						{selection.kind === 'toolset' && catalogView.missingOpIds.length > 0 ? (
							<InlineNotice title="当前 toolset 里有暂时不可用的 op">
								<Group gap={6} wrap="wrap">
									{catalogView.missingOpIds.map((opId) => (
										<Code key={opId}>{opId}</Code>
									))}
								</Group>
							</InlineNotice>
						) : null}

						{activeEntry.descriptor.transports.cli?.usage ? (
							<Paper withBorder radius="md" p="sm">
								<Stack gap={4}>
									<Text size="xs" fw={700} c="dimmed" tt="uppercase">
										CLI
									</Text>
									<Code block>{activeEntry.descriptor.transports.cli.usage}</Code>
								</Stack>
							</Paper>
						) : null}

						<Paper withBorder radius="md" p="sm">
							<Stack gap="sm">
								<Text size="xs" fw={700} c="dimmed" tt="uppercase">
									执行
								</Text>
								{activeEntry.descriptor.policy.mutating || activeEntry.descriptor.policy.confirm ? (
									<InlineNotice title="这个 op 会触发真实动作">
										<Text size="sm" c="dimmed">
											{activeEntry.descriptor.policy.confirm
												? '执行前会要求确认。'
												: '执行后会修改宿主状态或插件状态。'}
										</Text>
									</InlineNotice>
								) : null}

								{activeInputMode === 'none' ? (
									<Button
										leftSection={<IconPlayerPlay size={14} />}
										color={getRunTone(activeEntry)}
										loading={busyId === activeEntry.id}
										onClick={() => {
											void runEntry(activeEntry)
										}}
									>
										直接执行
									</Button>
								) : null}

								{activeInputMode === 'json-object' ? (
									<>
										{preparedEntryId === activeEntry.id ? (
											<>
												<Textarea
													label="执行输入"
													size="xs"
													minRows={8}
													autosize
													value={activeDraft}
													onChange={(event) =>
														setDrafts((prev) => ({
															...prev,
															[activeEntry.id]: event.currentTarget.value,
														}))
													}
													classNames={{ input: 'plx-opsMonospaceInput' }}
												/>
												<Group gap="xs">
													<Button
														leftSection={<IconPlayerPlay size={14} />}
														color={getRunTone(activeEntry)}
														loading={busyId === activeEntry.id}
														onClick={() => {
															void runEntry(activeEntry)
														}}
													>
														确认执行
													</Button>
													<Button variant="default" onClick={() => setPreparedEntryId(null)}>
														取消
													</Button>
												</Group>
											</>
										) : (
											<Button
												variant="light"
												leftSection={<IconPlayerPlay size={14} />}
												onClick={() => prepareEntry(activeEntry)}
											>
												准备执行
											</Button>
										)}
									</>
								) : null}

								{activeInputMode === 'unsupported' ? (
									<InlineNotice title="当前 UI 暂不支持该输入形态">
										<Text size="sm" c="dimmed">
											仅支持 object input op。其它输入形态仍可通过 CLI / MCP / 自定义客户端调用。
										</Text>
									</InlineNotice>
								) : null}
							</Stack>
						</Paper>

						{activeResult ? (
							<OpsRunResultCard result={activeResult} />
						) : (
							<Paper withBorder radius="md" p="sm">
								<Text size="sm" c="dimmed">
									还没有执行记录。执行后完整结果会显示在这里，主列表只保留紧凑状态。
								</Text>
							</Paper>
						)}
					</Stack>
				) : (
					<OpsPanelEmpty
						title="还没有选中操作"
						description="在中间列表点选一行，右侧就会切换到它的执行和结果面板。"
					/>
				)}
			</OpsPanelScroll>
		</OpsPanel>
	)

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

		if (entry.descriptor.policy.confirm) {
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
				<div className="plx-opsScreen__sidebar">{sidebarPane}</div>
				<div className="plx-opsScreen__catalog">{catalogPane}</div>
				<div className="plx-opsScreen__inspector">{inspectorPane}</div>
			</div>

			{toolsetDialog.mode !== 'closed' ? (
				<Modal
					opened
					onClose={closeToolsetDialog}
					title={toolsetDialog.mode === 'create' ? '新建 Toolset' : '重命名 Toolset'}
					centered
				>
					<Stack gap="sm">
						<Text size="sm" c="dimmed">
							Toolset 只保存一组 op id 和用途描述，方便宿主 UI 与 LLM/Agent 复用。
						</Text>
						<TextInput
							label="Toolset 名称"
							placeholder="例如：发布检查、常用维护、内容流水线"
							value={toolsetNameDraft}
							onChange={(event) => setToolsetNameDraft(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key !== 'Enter') return
								event.preventDefault()
								void submitToolsetDialog()
							}}
						/>
						<TextInput
							label="用途描述"
							placeholder="例如：用于发布前检查插件状态、依赖和配置，不包含内容生成类工具"
							value={toolsetDescriptionDraft}
							onChange={(event) => setToolsetDescriptionDraft(event.currentTarget.value)}
						/>
						<Group justify="flex-end">
							<Button variant="default" onClick={closeToolsetDialog}>
								取消
							</Button>
							<Button loading={toolsetsState.saving} onClick={() => void submitToolsetDialog()}>
								保存
							</Button>
						</Group>
					</Stack>
				</Modal>
			) : null}

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
