import { ActionIcon, Badge, Group, NavLink, Stack, Text } from '@mantine/core'
import { IconPlus } from '@tabler/icons-react'
import type { OpsExplorerSelection } from '../model'
import { OpsPanel, OpsPanelScroll, OpsSidebarSectionTitle } from './OpsPanel'
import { getToolsetSummaryDescription } from '../view'

type SidebarData = {
	counts: {
		all: number
		runtime: number
	}
	owners: Array<{
		count: number
		label: string
		owner: string
	}>
}

type ToolsetSummary = {
	availableCount: number
	description?: string
	missingCount: number
	name: string
	toolsetId: string
}

export function OpsSidebarPane({
	onCreateToolset,
	onSelect,
	selection,
	sidebar,
	toolsetSummaries,
	ungroupedCount,
}: {
	onCreateToolset: () => void
	onSelect: (selection: OpsExplorerSelection) => void
	selection: OpsExplorerSelection
	sidebar: SidebarData
	toolsetSummaries: ToolsetSummary[]
	ungroupedCount: number
}) {
	return (
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
						onClick={onCreateToolset}
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
						onClick={() => onSelect({ kind: 'all' })}
					/>
					<NavLink
						active={selection.kind === 'ungrouped'}
						label="未归组"
						description="还没进任何 toolset"
						rightSection={<Badge size="xs">{ungroupedCount}</Badge>}
						onClick={() => onSelect({ kind: 'ungrouped' })}
					/>
					<NavLink
						active={selection.kind === 'runtime'}
						label="宿主"
						description="runtime canonical ops"
						rightSection={<Badge size="xs">{sidebar.counts.runtime}</Badge>}
						onClick={() => onSelect({ kind: 'runtime' })}
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
								onClick={() => onSelect({ kind: 'toolset', toolsetId: toolset.toolsetId })}
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
								onClick={() => onSelect({ kind: 'owner', owner: owner.owner })}
							/>
						))
					)}
				</Stack>
			</OpsPanelScroll>
		</OpsPanel>
	)
}
