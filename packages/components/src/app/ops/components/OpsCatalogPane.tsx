import { ActionIcon, Badge, Button, Checkbox, Code, Group, Stack, Table, Text, TextInput } from '@mantine/core'
import {
	IconLayoutSidebarLeftCollapse,
	IconLayoutSidebarLeftExpand,
	IconLayoutSidebarRightCollapse,
	IconLayoutSidebarRightExpand,
	IconPencil,
	IconPlayerPlay,
	IconRefresh,
	IconSearch,
	IconStack2,
	IconTrash,
	IconX,
} from '@tabler/icons-react'
import type { RuntimeOpCatalogEntry } from '@pluxel/runtime/web'
import { InlineNotice } from '../../../components'
import {
	WorkbenchLayoutControls,
	WorkbenchLayoutToggleButton,
} from '../../workbench/LayoutControls'
import type { OpsExplorerSelection } from '../model'
import type { RunResult } from '../types'
import { formatRunStamp, getOwnerDisplay, getRunTone, selectionDescription, selectionLabel } from '../view'
import { OpsPanel, OpsPanelEmpty } from './OpsPanel'

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

type ToolsetBadge = {
	name: string
	toolsetId: string
}

export function OpsCatalogPane({
	activeEntryId,
	allVisibleSelected,
	busyId,
	emptyCatalogDescription,
	indeterminate,
	inspectorVisible,
	onAssignSelection,
	onOpenAssignModal,
	onClearSelection,
	onRefresh,
	onRenameToolset,
	onRowSelectionChange,
	onRunEntry,
	onSearchChange,
	onSelectEntry,
	onSelectVisibleChange,
	onToggleInspector,
	onToggleSidebar,
	onToolsetDelete,
	results,
	search,
	selectedCount,
	selectedOpIdSet,
	selectedToolset,
	selection,
	showToolsetError,
	sidebarVisible,
	syncing,
	toolsetErrorMessage,
	toolsetsByOpId,
	visibleEntries,
}: {
	activeEntryId: string | null
	allVisibleSelected: boolean
	busyId: string | null
	emptyCatalogDescription: string
	indeterminate: boolean
	inspectorVisible: boolean
	onAssignSelection: () => void
	onOpenAssignModal: (opIds: string[]) => void
	onClearSelection: () => void
	onRefresh: () => void
	onRenameToolset: () => void
	onRowSelectionChange: (opId: string, checked: boolean) => void
	onRunEntry: (entry: RuntimeOpCatalogEntry) => void
	onSearchChange: (value: string) => void
	onSelectEntry: (entryId: string) => void
	onSelectVisibleChange: (checked: boolean) => void
	onToggleInspector: () => void
	onToggleSidebar: () => void
	onToolsetDelete: () => void
	results: Record<string, RunResult>
	search: string
	selectedCount: number
	selectedOpIdSet: Set<string>
	selectedToolset: { name: string } | null
	selection: OpsExplorerSelection
	showToolsetError: boolean
	sidebarVisible: boolean
	syncing: boolean
	toolsetErrorMessage?: string
	toolsetsByOpId: Map<string, ToolsetBadge[]>
	visibleEntries: RuntimeOpCatalogEntry[]
}) {
	const layoutToggles = [
		{
			key: 'sidebar',
			hiddenIcon: <IconLayoutSidebarLeftCollapse size={16} />,
			hideLabel: '隐藏左栏',
			onClick: onToggleSidebar,
			showIcon: <IconLayoutSidebarLeftExpand size={16} />,
			showLabel: '显示左栏',
			visible: sidebarVisible,
		},
		{
			key: 'inspector',
			hiddenIcon: <IconLayoutSidebarRightCollapse size={16} />,
			hideLabel: '隐藏右栏',
			onClick: onToggleInspector,
			showIcon: <IconLayoutSidebarRightExpand size={16} />,
			showLabel: '显示右栏',
			visible: inspectorVisible,
		},
	]

	return (
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
							<WorkbenchLayoutControls className="plx-opsCatalog__layoutControls">
								{layoutToggles.map((toggle) => (
									<WorkbenchLayoutToggleButton key={toggle.key} {...toggle} />
								))}
							</WorkbenchLayoutControls>
							{selectedToolset ? (
								<>
									<ActionIcon
										variant="subtle"
										color="gray"
										onClick={onRenameToolset}
										title="重命名 Toolset"
										aria-label="重命名 Toolset"
									>
										<IconPencil size={16} />
									</ActionIcon>
									<ActionIcon
										variant="subtle"
										color="red"
										onClick={onToolsetDelete}
										title="删除 Toolset"
										aria-label="删除 Toolset"
									>
										<IconTrash size={16} />
									</ActionIcon>
								</>
							) : null}
							<OpsSelectionActions
								selectedCount={selectedCount}
								onAssign={onAssignSelection}
								onClear={onClearSelection}
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
								onClick={onRefresh}
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
						onChange={(event) => onSearchChange(event.currentTarget.value)}
					/>
				</Stack>
			}
		>
			<div className="plx-opsCatalog">
				<div className="plx-opsCatalog__meta">
					{showToolsetError && toolsetErrorMessage ? (
						<div className="plx-opsCatalog__notice">
							<InlineNotice title="Toolset 保存链路最近返回了错误">
								<Text size="sm" c="dimmed">
									{toolsetErrorMessage}
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
												onChange={(event) => onSelectVisibleChange(event.currentTarget.checked)}
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
												onClick={() => onSelectEntry(entry.id)}
											>
												<Table.Td onClick={(event) => event.stopPropagation()}>
													<Checkbox
														checked={selectedOpIdSet.has(entry.id)}
														onChange={(event) =>
															onRowSelectionChange(entry.id, event.currentTarget.checked)
														}
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
															onClick={() => onOpenAssignModal([entry.id])}
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
																void onRunEntry(entry)
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
}
