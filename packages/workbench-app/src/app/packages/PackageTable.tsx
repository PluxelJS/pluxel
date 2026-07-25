import {
	ActionIcon,
	Badge,
	Box,
	Checkbox,
	Flex,
	Group,
	Loader,
	Paper,
	ScrollArea,
	Stack,
	Table,
	Text,
	Tooltip,
} from '@mantine/core'
import {
	IconPackages,
	IconRefresh,
	IconRotateClockwise,
	IconSearch as IconSearchEmpty,
	IconTrash,
	IconX,
} from '@tabler/icons-react'
import { EmptyState } from '../../components'
import { RouterLinkAdapter } from '../RouterLinkAdapter'
import { formatSpec, type PackageBusyKey, type PackageRow } from './packageManagerModel'

interface PackageTableProps {
	busy: boolean
	busyKey: PackageBusyKey | null
	filteredRows: PackageRow[]
	onBatchReinstall: () => void
	onBatchReload: () => void
	onBatchRemove: () => void
	onBatchUninstall: () => void
	onClearSelection: () => void
	onLoad: (row: PackageRow) => void
	onRemove: (row: PackageRow) => void
	onReinstall: (row: PackageRow) => void
	onRowSelectedChange: (name: string, checked: boolean) => void
	onSelectAllVisibleChange: (checked: boolean) => void
	onUninstall: (row: PackageRow) => void
	packageSearch: string
	refreshing: boolean
	searchActive: boolean
	selectedPackages: Set<string>
	selectedVisibleCount: number
}

export function PackageTable({
	busy,
	busyKey,
	filteredRows,
	onBatchReinstall,
	onBatchReload,
	onBatchRemove,
	onBatchUninstall,
	onClearSelection,
	onLoad,
	onRemove,
	onReinstall,
	onRowSelectedChange,
	onSelectAllVisibleChange,
	onUninstall,
	packageSearch,
	refreshing,
	searchActive,
	selectedPackages,
	selectedVisibleCount,
}: PackageTableProps) {
	if (filteredRows.length === 0) {
		if (refreshing) {
			return (
				<Box
					p="md"
					style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center' }}
				>
					<Group gap="sm">
						<Loader size="sm" />
						<Text c="dimmed">正在加载包信息…</Text>
					</Group>
				</Box>
			)
		}
		return searchActive ? (
			<EmptyState
				icon={<IconSearchEmpty size={28} stroke={1.5} />}
				title={`没有匹配"${packageSearch.trim()}"的结果`}
				description="尝试其他关键词，或清空搜索条件查看全部包。"
				minHeight={200}
			/>
		) : (
			<EmptyState
				icon={<IconPackages size={28} stroke={1.5} />}
				title="暂无包数据"
				description="可先在上方安装新包，或等待插件上报。"
				minHeight={200}
			/>
		)
	}

	const allVisibleSelected = filteredRows.length > 0 && selectedVisibleCount === filteredRows.length
	const isIndeterminate = selectedVisibleCount > 0 && selectedVisibleCount < filteredRows.length

	return (
		<Stack gap="xs" style={{ height: '100%' }}>
			{selectedPackages.size > 0 && (
				<PackageSelectionBar
					busy={busy}
					busyKey={busyKey}
					selectedCount={selectedPackages.size}
					onBatchReinstall={onBatchReinstall}
					onBatchReload={onBatchReload}
					onBatchRemove={onBatchRemove}
					onBatchUninstall={onBatchUninstall}
					onClearSelection={onClearSelection}
				/>
			)}
			<ScrollArea style={{ flex: 1 }}>
				<Table striped highlightOnHover miw={720} verticalSpacing={6}>
					<Table.Thead>
						<Table.Tr>
							<Table.Th w={42}>
								<Checkbox
									checked={allVisibleSelected}
									indeterminate={isIndeterminate}
									onChange={(event) => onSelectAllVisibleChange(event.currentTarget.checked)}
									aria-label="全选"
								/>
							</Table.Th>
							<Table.Th>包</Table.Th>
							<Table.Th>版本</Table.Th>
							<Table.Th>加载</Table.Th>
							<Table.Th>引用插件</Table.Th>
							<Table.Th>状态</Table.Th>
							<Table.Th>操作</Table.Th>
						</Table.Tr>
					</Table.Thead>
					<Table.Tbody>
						{filteredRows.map((row) => (
							<PackageTableRow
								key={row.name}
								busy={busy}
								row={row}
								selected={selectedPackages.has(row.name)}
								onLoad={onLoad}
								onRemove={onRemove}
								onReinstall={onReinstall}
								onSelectedChange={onRowSelectedChange}
								onUninstall={onUninstall}
							/>
						))}
					</Table.Tbody>
				</Table>
			</ScrollArea>
		</Stack>
	)
}

interface PackageSelectionBarProps {
	busy: boolean
	busyKey: PackageBusyKey | null
	onBatchReinstall: () => void
	onBatchReload: () => void
	onBatchRemove: () => void
	onBatchUninstall: () => void
	onClearSelection: () => void
	selectedCount: number
}

function PackageSelectionBar({
	busy,
	busyKey,
	onBatchReinstall,
	onBatchReload,
	onBatchRemove,
	onBatchUninstall,
	onClearSelection,
	selectedCount,
}: PackageSelectionBarProps) {
	return (
		<Paper
			withBorder
			radius="md"
			px="sm"
			py={6}
			style={{
				background: 'var(--plx-accent-soft)',
				borderColor: 'var(--plx-selected-border)',
			}}
		>
			<Group gap="sm" align="center" wrap="nowrap">
				<Text size="sm" fw={600} style={{ color: 'var(--plx-accent-strong)' }}>
					已选 {selectedCount} 项
				</Text>
				<Group gap={6}>
					<Tooltip label="重载所选包">
						<ActionIcon
							variant="light"
							color="brand"
							size="md"
							onClick={onBatchReload}
							disabled={busy && busyKey !== 'batch-reload'}
							loading={busyKey === 'batch-reload'}
						>
							<IconRefresh size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label="重装所选包">
						<ActionIcon
							variant="light"
							color="brand"
							size="md"
							disabled={busy && busyKey !== 'batch-reinstall'}
							loading={busyKey === 'batch-reinstall'}
							onClick={onBatchReinstall}
						>
							<IconRotateClockwise size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label="卸载运行态">
						<ActionIcon
							variant="light"
							color="orange"
							size="md"
							disabled={busy && busyKey !== 'batch-uninstall'}
							loading={busyKey === 'batch-uninstall'}
							onClick={onBatchUninstall}
						>
							<IconTrash size={18} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label="彻底移除">
						<ActionIcon
							variant="light"
							color="red"
							size="md"
							disabled={busy && busyKey !== 'batch-remove'}
							loading={busyKey === 'batch-remove'}
							onClick={onBatchRemove}
						>
							<IconX size={18} />
						</ActionIcon>
					</Tooltip>
				</Group>
				<ActionIcon
					variant="subtle"
					color="gray"
					size="sm"
					onClick={onClearSelection}
					style={{ marginLeft: 'auto' }}
				>
					<IconX size={14} />
				</ActionIcon>
			</Group>
		</Paper>
	)
}

interface PackageTableRowProps {
	busy: boolean
	onLoad: (row: PackageRow) => void
	onRemove: (row: PackageRow) => void
	onReinstall: (row: PackageRow) => void
	onSelectedChange: (name: string, checked: boolean) => void
	onUninstall: (row: PackageRow) => void
	row: PackageRow
	selected: boolean
}

function PackageTableRow({
	busy,
	onLoad,
	onRemove,
	onReinstall,
	onSelectedChange,
	onUninstall,
	row,
	selected,
}: PackageTableRowProps) {
	return (
		<Table.Tr>
			<Table.Td py={5}>
				<Checkbox
					checked={selected}
					onChange={(event) => onSelectedChange(row.name, event.currentTarget.checked)}
					aria-label={`选择 ${row.name}`}
				/>
			</Table.Td>
			<Table.Td py={5}>
				<Flex gap={6} align="center" wrap="wrap">
					<Text fw={600}>{row.name}</Text>
					{row.pluginNames.length > 0 ? (
						row.pluginNames.map((plugin) => (
							<Badge
								key={plugin}
								variant="light"
								color="brand"
								component={RouterLinkAdapter}
								to={`/plugins/${encodeURIComponent(plugin)}`}
								style={{ cursor: 'pointer' }}
							>
								{plugin}
							</Badge>
						))
					) : (
						<Text size="xs" c="dimmed">
							暂无关联插件
						</Text>
					)}
				</Flex>
			</Table.Td>
			<Table.Td py={5}>
				<Badge variant="light" color="gray">
					{formatSpec(row)}
				</Badge>
			</Table.Td>
			<Table.Td py={5}>
				<Badge color={row.loaded ? 'green' : 'gray'} variant="light">
					{row.loaded ? '已加载' : '未加载'}
				</Badge>
			</Table.Td>
			<Table.Td py={5}>
				<Text size="sm">
					{row.runningCount}/{row.pluginCount} 运行中
				</Text>
			</Table.Td>
			<Table.Td py={5}>
				{row.issues.length > 0 ? (
					<Badge color="red" variant="filled">
						{row.issues.length} 个告警
					</Badge>
				) : (
					<Badge color="green" variant="light">
						正常
					</Badge>
				)}
			</Table.Td>
			<Table.Td py={5}>
				<Group justify="flex-end" gap={6}>
					{row.loaded ? (
						<Tooltip label="重装">
							<ActionIcon
								variant="light"
								color="brand"
								size="md"
								onClick={() => onReinstall(row)}
								disabled={busy}
							>
								<IconRotateClockwise size={16} />
							</ActionIcon>
						</Tooltip>
					) : (
						<Tooltip label="加载">
							<ActionIcon
								variant="light"
								color="green"
								size="md"
								onClick={() => onLoad(row)}
								disabled={busy}
							>
								<IconRefresh size={16} />
							</ActionIcon>
						</Tooltip>
					)}
					<Tooltip label="卸载运行态">
						<ActionIcon
							variant="light"
							color="orange"
							size="md"
							onClick={() => onUninstall(row)}
							disabled={busy}
						>
							<IconTrash size={16} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label="彻底移除">
						<ActionIcon
							variant="light"
							color="red"
							size="md"
							onClick={() => onRemove(row)}
							disabled={busy}
						>
							<IconX size={16} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Table.Td>
		</Table.Tr>
	)
}
