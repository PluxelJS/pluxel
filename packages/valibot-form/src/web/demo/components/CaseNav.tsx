import {
	ActionIcon,
	Badge,
	Button,
	Divider,
	Group,
	NavLink,
	ScrollArea,
	Select,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from '@mantine/core'
import { IconSearch, IconX } from '@tabler/icons-react'
import type { CaseGroup, CaseGroupId, DemoCase } from '../data/cases'

export interface CaseGroupBucket {
	group: CaseGroup
	cases: DemoCase[]
}

export interface CaseNavProps {
	groups: CaseGroup[]
	groupedCases: CaseGroupBucket[]
	activeId: string
	onSelect: (id: string) => void
	query: string
	onQueryChange: (value: string) => void
	groupFilter: CaseGroupId | 'all'
	onGroupFilterChange: (value: CaseGroupId | 'all') => void
	tags: string[]
	activeTags: string[]
	onToggleTag: (tag: string) => void
	onClearFilters: () => void
	totalCount: number
	resultCount: number
}

export function CaseNav({
	groups,
	groupedCases,
	activeId,
	onSelect,
	query,
	onQueryChange,
	groupFilter,
	onGroupFilterChange,
	tags,
	activeTags,
	onToggleTag,
	onClearFilters,
	totalCount,
	resultCount,
}: CaseNavProps) {
	const hasFilters = Boolean(query) || groupFilter !== 'all' || activeTags.length > 0

	return (
		<Stack gap="sm" style={{ height: '100%' }}>
			<Group justify="space-between" align="center">
				<Text size="xs" c="dimmed">
					显示 {resultCount} / {totalCount}
				</Text>
				{hasFilters ? (
					<Badge size="xs" variant="light" color="blue">
						已筛选
					</Badge>
				) : null}
			</Group>
			<TextInput
				value={query}
				onChange={(event) => onQueryChange(event.currentTarget.value)}
				placeholder="搜索 demo..."
				leftSection={<IconSearch size={14} />}
				rightSection={
					query ? (
						<ActionIcon
							variant="subtle"
							color="gray"
							aria-label="清空搜索"
							onClick={() => onQueryChange('')}
						>
							<IconX size={14} />
						</ActionIcon>
					) : undefined
				}
				size="sm"
			/>

			<Select
				data={[
					{ value: 'all', label: '全部分组' },
					...groups.map((group) => ({
						value: group.id,
						label: group.label,
					})),
				]}
				value={groupFilter}
				onChange={(value) => onGroupFilterChange((value as CaseGroupId | 'all') ?? 'all')}
				size="sm"
				placeholder="选择分组"
				allowDeselect={false}
			/>

			{tags.length > 0 ? (
				<Stack gap={6}>
					<Group gap={6} wrap="wrap">
						{tags.map((tag) => {
							const active = activeTags.includes(tag)
							return (
								<UnstyledButton key={tag} onClick={() => onToggleTag(tag)} aria-pressed={active}>
									<Badge
										variant={active ? 'filled' : 'outline'}
										color={active ? 'blue' : 'gray'}
										size="sm"
										radius="sm"
									>
										{tag}
									</Badge>
								</UnstyledButton>
							)
						})}
					</Group>
					{hasFilters ? (
						<Button variant="subtle" size="xs" color="gray" onClick={onClearFilters}>
							清除筛选
						</Button>
					) : null}
				</Stack>
			) : null}

			<Divider />

			<ScrollArea style={{ flex: 1 }} offsetScrollbars>
				{groupedCases.length > 0 ? (
					<Stack gap="md">
						{groupedCases.map((bucket) => (
							<Stack key={bucket.group.id} gap={6}>
								<Stack gap={2}>
									<Text size="xs" fw={700} c="dimmed">
										{bucket.group.label}
									</Text>
									<Text size="xs" c="dimmed">
										{bucket.group.description}
									</Text>
								</Stack>
								<Stack gap={4}>
									{bucket.cases.map((item) => (
										<NavLink
											key={item.id}
											active={item.id === activeId}
											label={
												<Stack gap={2}>
													<Text size="sm" fw={600}>
														{item.label}
													</Text>
													{item.description ? (
														<Text size="xs" c="dimmed" lineClamp={2}>
															{item.description}
														</Text>
													) : null}
													<Group gap={4} wrap="wrap">
														{item.tags.slice(0, 3).map((tag) => (
															<Badge key={`${item.id}-${tag}`} size="xs" variant="light">
																{tag}
															</Badge>
														))}
													</Group>
												</Stack>
											}
											onClick={() => onSelect(item.id)}
										/>
									))}
								</Stack>
							</Stack>
						))}
					</Stack>
				) : (
					<Text size="sm" c="dimmed">
						没有匹配的案例
					</Text>
				)}
			</ScrollArea>
		</Stack>
	)
}
