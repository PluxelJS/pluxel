import {
	ActionIcon,
	Badge,
	Button,
	Checkbox,
	Group,
	Kbd,
	Paper,
	Text,
	TextInput,
	Tooltip,
} from '@mantine/core'
import { IconRefresh, IconSearch, IconTerminal2, IconX } from '@tabler/icons-react'
import type { RefObject } from 'react'

export interface PackageSummaryStat {
	color?: string
	label: string
	value: number
}

interface PackageManagerToolbarProps {
	filteredCount: number
	issueCount: number
	onOpenOperationLog: () => void
	onPackageSearchChange: (value: string) => void
	onRefresh: () => void
	onShowIssuesPanel: () => void
	onShowAllPackagesChange: (value: boolean) => void
	packageSearch: string
	refreshing: boolean
	rowCount: number
	searchInputRef: RefObject<HTMLInputElement | null>
	showAllPackages: boolean
	showIssuesPanel: boolean
	stats: PackageSummaryStat[]
}

export function PackageManagerToolbar({
	filteredCount,
	issueCount,
	onOpenOperationLog,
	onPackageSearchChange,
	onRefresh,
	onShowIssuesPanel,
	onShowAllPackagesChange,
	packageSearch,
	refreshing,
	rowCount,
	searchInputRef,
	showAllPackages,
	showIssuesPanel,
	stats,
}: PackageManagerToolbarProps) {
	return (
		<Paper withBorder radius="sm" p="xs">
			<Group justify="space-between" align="center" wrap="wrap" gap="xs">
				<Group gap={6} wrap="wrap">
					{stats.map((stat) => (
						<Badge key={stat.label} variant="light" color={stat.color ?? 'gray'}>
							{stat.label} {stat.value}
						</Badge>
					))}
					<Badge variant="light" color="gray">
						列表 {filteredCount} / {rowCount}
					</Badge>
				</Group>
				<Group gap="xs" wrap="wrap">
					<Tooltip
						label={
							<Group gap={4}>
								<Kbd size="xs">Ctrl</Kbd>
								<Text size="xs">+</Text>
								<Kbd size="xs">F</Kbd>
								<Text size="xs">搜索</Text>
							</Group>
						}
						position="bottom"
					>
						<TextInput
							ref={searchInputRef}
							placeholder="搜索包名或插件..."
							leftSection={<IconSearch size={14} />}
							rightSection={
								packageSearch && (
									<ActionIcon size="xs" variant="subtle" onClick={() => onPackageSearchChange('')}>
										<IconX size={12} />
									</ActionIcon>
								)
							}
							value={packageSearch}
							onChange={(event) => onPackageSearchChange(event.currentTarget.value)}
							size="sm"
							style={{ width: 240, maxWidth: '100%' }}
						/>
					</Tooltip>
					<Checkbox
						label="全部依赖"
						checked={showAllPackages}
						onChange={(event) => onShowAllPackagesChange(event.currentTarget.checked)}
						size="sm"
					/>
					<Button
						leftSection={<IconRefresh size={16} />}
						variant="light"
						size="sm"
						onClick={onRefresh}
						loading={refreshing}
					>
						刷新
					</Button>
					<Tooltip label="查看操作日志">
						<ActionIcon variant="light" color="gray" onClick={onOpenOperationLog}>
							<IconTerminal2 size={16} />
						</ActionIcon>
					</Tooltip>
					{!showIssuesPanel && issueCount > 0 && (
						<Tooltip label="显示告警面板">
							<ActionIcon variant="light" color="red" onClick={onShowIssuesPanel}>
								<Badge color="red" size="xs" circle>
									{issueCount}
								</Badge>
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Group>
		</Paper>
	)
}
