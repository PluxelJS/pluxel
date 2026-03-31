import {
	ActionIcon,
	Badge,
	Card,
	Collapse,
	Code,
	Group,
	ScrollArea,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from '@mantine/core'
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconX } from '@tabler/icons-react'
import { useState, useMemo } from 'react'
import { ISSUE_SOURCE_LABEL } from '../types'

// 独立的数据结构，避免 gqty 懒加载问题
export interface IssueData {
	name: string
	version: string | null
	tag: string | null
	raw: string | null
	target: string | null
	message: string
	error: string | null
	source: string
	recordedAt: number
}

interface CollapsibleIssuesPanelProps {
	issues: IssueData[]
	maxHeight?: number
	onClose?: () => void
}

const timeFormatter = new Intl.DateTimeFormat('zh-CN', {
	month: '2-digit',
	day: '2-digit',
	hour: '2-digit',
	minute: '2-digit',
	second: '2-digit',
})

const ERROR_PANEL_STYLES = {
	card: {
		borderColor:
			'color-mix(in srgb, var(--plx-state-error-border) 78%, var(--plx-panel-border-strong) 22%)',
		backgroundColor:
			'color-mix(in srgb, var(--plx-state-error-bg) 42%, var(--plx-panel-bg) 58%)',
	},
	header: {
		borderBottom:
			'1px solid color-mix(in srgb, var(--plx-state-error-border) 70%, var(--plx-panel-border) 30%)',
		backgroundColor:
			'color-mix(in srgb, var(--plx-state-error-bg) 64%, var(--plx-panel-bg) 36%)',
	},
	row: {
		borderBottom:
			'1px solid color-mix(in srgb, var(--plx-state-error-border) 54%, var(--plx-panel-border) 46%)',
	},
} as const

function formatTime(value: number | null | undefined) {
	if (!value || Number.isNaN(value)) return '未知时间'
	try {
		return timeFormatter.format(new Date(value))
	} catch {
		return '未知时间'
	}
}

function formatVersion(issue: IssueData) {
	if (issue.version) return `v${issue.version}`
	if (issue.tag) return `tag: ${issue.tag}`
	if (issue.raw && issue.raw !== issue.name) return issue.raw
	return 'latest'
}

export function CollapsibleIssuesPanel({
	issues,
	maxHeight = 200,
	onClose,
}: CollapsibleIssuesPanelProps) {
	const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

	// 使用索引生成唯一key，避免同包多告警的key冲突
	const sortedIssues = useMemo(() => {
		const sorted = [...issues].sort((a, b) => (b.recordedAt ?? 0) - (a.recordedAt ?? 0))
		return sorted.map((issue, index) => ({
			...issue,
			uniqueKey: `${issue.name}-${issue.recordedAt}-${index}`,
		}))
	}, [issues])

	if (sortedIssues.length === 0) {
		return null
	}

	const toggleExpand = (key: string) => {
		setExpandedKeys((prev) => {
			const next = new Set(prev)
			if (next.has(key)) {
				next.delete(key)
			} else {
				next.add(key)
			}
			return next
		})
	}

	const expandAll = () => {
		setExpandedKeys(new Set(sortedIssues.map((issue) => issue.uniqueKey)))
	}

	const collapseAll = () => {
		setExpandedKeys(new Set())
	}

	return (
		<Card
			withBorder
			shadow="sm"
			radius="md"
			p={0}
			style={ERROR_PANEL_STYLES.card}
		>
			<Group
				justify="space-between"
				px="sm"
				py="xs"
				style={ERROR_PANEL_STYLES.header}
			>
				<Group gap="xs">
					<IconAlertTriangle size={16} color="var(--plx-state-error-icon-color)" />
					<Text size="sm" fw={600} c="var(--plx-state-error-title)">
						{sortedIssues.length} 个加载告警
					</Text>
				</Group>
				<Group gap={4}>
					<Tooltip label="全部展开" position="top">
						<ActionIcon variant="subtle" color="red" size="xs" onClick={expandAll}>
							<IconChevronDown size={14} />
						</ActionIcon>
					</Tooltip>
					<Tooltip label="全部折叠" position="top">
						<ActionIcon variant="subtle" color="red" size="xs" onClick={collapseAll}>
							<IconChevronRight size={14} />
						</ActionIcon>
					</Tooltip>
					{onClose && (
						<Tooltip label="关闭面板" position="top">
							<ActionIcon variant="subtle" color="red" size="xs" onClick={onClose}>
								<IconX size={14} />
							</ActionIcon>
						</Tooltip>
					)}
				</Group>
			</Group>
			<ScrollArea.Autosize mah={maxHeight} type="auto" offsetScrollbars>
				<Stack gap={0}>
					{sortedIssues.map((issue) => {
						const key = issue.uniqueKey
						const isExpanded = expandedKeys.has(key)
						return (
							<div
								key={key}
								style={ERROR_PANEL_STYLES.row}
							>
								<UnstyledButton
									onClick={() => toggleExpand(key)}
									style={{
										width: '100%',
										padding: '8px 12px',
										display: 'flex',
										alignItems: 'center',
										gap: 8,
									}}
								>
									{isExpanded ? (
										<IconChevronDown size={14} color="var(--plx-state-error-icon-color)" />
									) : (
										<IconChevronRight size={14} color="var(--plx-state-error-icon-color)" />
									)}
									<Badge color="red" size="xs" variant="light">
										{ISSUE_SOURCE_LABEL[issue.source] ?? issue.source}
									</Badge>
									<Text size="sm" fw={600} style={{ flex: 1, textAlign: 'left' }} lineClamp={1}>
										{issue.name}
									</Text>
									<Text size="xs" c="dimmed">
										{formatTime(issue.recordedAt)}
									</Text>
								</UnstyledButton>
								<Collapse in={isExpanded}>
									<Stack gap="xs" px="md" pb="sm" pt={0}>
										<Group gap="xs">
											<Badge size="xs" variant="light" color="gray">
												{formatVersion(issue)}
											</Badge>
											{issue.target && (
												<Text size="xs" c="dimmed">
													入口: {issue.target}
												</Text>
											)}
										</Group>
										<Text
											size="sm"
											c="var(--plx-state-error-title)"
											style={{ wordBreak: 'break-word' }}
										>
											{issue.message}
										</Text>
										{issue.error && (
											<Code
												block
												style={{
													fontSize: 11,
													maxHeight: 120,
													overflow: 'auto',
													whiteSpace: 'pre-wrap',
													wordBreak: 'break-all',
												}}
											>
												{issue.error}
											</Code>
										)}
									</Stack>
								</Collapse>
							</div>
						)
					})}
				</Stack>
			</ScrollArea.Autosize>
		</Card>
	)
}
