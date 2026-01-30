import { ActionIcon, Badge, Group, SegmentedControl, Stack, Text, Title } from '@mantine/core'
import { IconChevronLeft, IconChevronRight } from '@tabler/icons-react'
import type { DemoCase } from '../data/cases'
import type { CaseStats } from '../utils/stats'

export type DensityMode = 'comfortable' | 'compact'

export interface CaseHeaderProps {
	caseItem: DemoCase
	stats: CaseStats | null
	groupLabel?: string
	playgroundActive?: boolean
	density: DensityMode
	setDensity: (next: DensityMode) => void
	hasPrev: boolean
	hasNext: boolean
	onPrev: () => void
	onNext: () => void
}

export function CaseHeader({
	caseItem,
	stats,
	groupLabel,
	playgroundActive,
	density,
	setDensity,
	hasPrev,
	hasNext,
	onPrev,
	onNext,
}: CaseHeaderProps) {
	return (
		<Group justify="space-between" align="flex-start" wrap="nowrap">
			<Stack gap={6} style={{ maxWidth: 720 }}>
				<Group gap="sm" align="center">
					<Title order={4}>{caseItem.label}</Title>
					<Badge variant="outline">{caseItem.id}</Badge>
					{groupLabel ? <Badge variant="light">{groupLabel}</Badge> : null}
					{playgroundActive ? (
						<Badge color="grape" variant="filled">
							Playground
						</Badge>
					) : null}
					{stats ? (
						<Group gap={6}>
							<Badge variant="light">字段 {stats.fieldCount}</Badge>
							<Badge variant="light">复杂 {stats.complexCount}</Badge>
							<Badge variant="light">分区 {stats.sectionCount}</Badge>
						</Group>
					) : null}
				</Group>
				{caseItem.description ? (
					<Text size="sm" c="dimmed">
						{caseItem.description}
					</Text>
				) : null}
				<Group gap={6} wrap="wrap">
					{caseItem.tags.map((tag) => (
						<Badge key={`${caseItem.id}-${tag}`} variant="outline" size="sm">
							{tag}
						</Badge>
					))}
				</Group>
			</Stack>
			<Group gap="md" align="center">
				<Group gap={6}>
					<ActionIcon
						variant="subtle"
						aria-label="上一条"
						disabled={!hasPrev}
						onClick={onPrev}
					>
						<IconChevronLeft size={16} />
					</ActionIcon>
					<ActionIcon
						variant="subtle"
						aria-label="下一条"
						disabled={!hasNext}
						onClick={onNext}
					>
						<IconChevronRight size={16} />
					</ActionIcon>
				</Group>
				<SegmentedControl
					value={density}
					onChange={(value) => setDensity(value as DensityMode)}
					data={[
						{ label: '舒适', value: 'comfortable' },
						{ label: '紧凑', value: 'compact' },
					]}
					size="sm"
				/>
			</Group>
		</Group>
	)
}
