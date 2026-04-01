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
import { ISSUE_SOURCE_LABEL, type IssueData } from './packageManagerModel'

interface PackageIssuesPanelProps {
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

export function PackageIssuesPanel({
	issues,
	maxHeight = 200,
	onClose,
}: PackageIssuesPanelProps) {
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
		<Card withBorder shadow="sm" radius="md" p={0}>
			<Group
				justify="space-between"
				px="sm"
				py="xs"
				style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
			>
				<Group gap="xs">
					<IconAlertTriangle size={16} color="var(--mantine-color-red-6)" />
					<Text size="sm" fw={600} c="red">
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
								style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
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
										<IconChevronDown size={14} color="var(--mantine-color-red-6)" />
									) : (
										<IconChevronRight size={14} color="var(--mantine-color-red-6)" />
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
										<Text size="sm" c="red" style={{ wordBreak: 'break-word' }}>
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
