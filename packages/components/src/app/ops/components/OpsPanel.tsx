import { Group, Paper, Stack, Text } from '@mantine/core'
import { IconTool } from '@tabler/icons-react'
import type { ReactNode } from 'react'
import { EmptyState } from '../../../components'
import type { RunResult } from '../types'
import { formatRunStamp } from '../view'

export function OpsPanel({
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

export function OpsPanelScroll({ children }: { children: ReactNode }) {
	return <div className="plx-opsPanel__scroll">{children}</div>
}

export function OpsSidebarSectionTitle({ children }: { children: ReactNode }) {
	return (
		<Text size="xs" fw={700} c="dimmed" tt="uppercase" mt="sm" px="sm">
			{children}
		</Text>
	)
}

export function OpsPanelEmpty({
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

export function OpsRunResultCard({ result }: { result: RunResult }) {
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
