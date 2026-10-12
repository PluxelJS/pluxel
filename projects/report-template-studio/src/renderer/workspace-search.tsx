import { useEffect, useState } from 'react'
import {
	Alert,
	ActionIcon,
	Checkbox,
	Loader,
	Stack,
	Text,
	TextInput,
	UnstyledButton,
} from '@mantine/core'
import { IconSearch, IconX } from '@tabler/icons-react'
import type { SearchMatch, SearchResult } from '../shared/search'
import { api } from './api'
import type { WorkspaceController } from './workspace'

export function WorkspaceSearch({
	workspace,
	active,
	open,
}: {
	workspace: WorkspaceController
	active: boolean
	open(match: SearchMatch): void
}) {
	const [query, setQuery] = useState('')
	const [caseSensitive, setCaseSensitive] = useState(false)
	const [result, setResult] = useState<SearchResult>()
	const [error, setError] = useState('')
	const [loading, setLoading] = useState(false)
	useEffect(() => {
		if (!active) return
		let current = true
		setResult(undefined)
		setError('')
		setLoading(!!query.trim())
		const timer = setTimeout(() => {
			if (!query.trim()) return
			void api
				.search({ projectId: workspace.project.id, query, mode: 'content', caseSensitive })
				.then((value) => {
					if (current) setResult(value)
					return undefined
				})
				.catch((cause) => {
					if (current) setError(String(cause))
				})
				.finally(() => {
					if (current) setLoading(false)
				})
		}, 200)
		return () => {
			current = false
			clearTimeout(timer)
		}
	}, [query, active, caseSensitive, workspace, workspace.tree?.revision])
	return (
		<Stack gap="xs" style={{ minHeight: 0, flex: 1 }}>
			<TextInput
				size="xs"
				aria-label="搜索代码"
				placeholder="搜索代码内容…"
				value={query}
				maxLength={500}
				onChange={(event) => setQuery(event.currentTarget.value)}
				leftSection={<IconSearch size={14} />}
				rightSection={
					loading ? (
						<Loader size={14} />
					) : query ? (
						<ActionIcon
							size="xs"
							variant="subtle"
							color="gray"
							aria-label="清空代码搜索"
							onClick={() => setQuery('')}
						>
							<IconX size={13} />
						</ActionIcon>
					) : undefined
				}
			/>
			<Checkbox
				size="xs"
				label="区分大小写"
				checked={caseSensitive}
				onChange={(event) => setCaseSensitive(event.currentTarget.checked)}
			/>
			{error && <Alert color="red">{error}</Alert>}
			<Text size="xs" c="dimmed">
				{!query.trim()
					? '输入搜索词查找代码内容'
					: loading
						? '搜索中…'
						: `${result?.matches.length ?? 0} 个结果${result?.truncated ? '（仅显示前 200 项）' : ''}`}
			</Text>
			<Text size="xs" c="dimmed">
				搜索已保存的文本；点击结果跳到对应行。
				{result?.skipped ? `已跳过 ${result.skipped} 个超过 2 MiB 的文件。` : ''}
			</Text>
			<div className="workspace-search-results">
				{result?.matches.map((match) => (
					<UnstyledButton
						className="workspace-search-result"
						key={`${match.path}:${match.line ?? 0}`}
						onClick={() => open(match)}
						title={match.path}
					>
						<Text size="xs" fw={500} style={{ overflowWrap: 'anywhere' }}>
							{match.path}
							{match.line ? `:${match.line}` : ''}
						</Text>
						{match.text !== undefined && (
							<Text size="xs" c="dimmed" className="workspace-search-excerpt">
								{match.text}
							</Text>
						)}
					</UnstyledButton>
				))}
			</div>
		</Stack>
	)
}
