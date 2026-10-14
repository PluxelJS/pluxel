import { Autocomplete, Button, Group, Popover, Stack, Text, TextInput } from '@mantine/core'
import { useQuery } from '@tanstack/react-query'
import { useState } from 'react'
import { useRuntimeManagementClient } from '../../runtime'
import { managementQueryKeys } from '../managementQuery'
import { type LogsSearch, validateLogsSearch } from '../router/logsSearch'

/** Draft edits stay local until Apply; the parent owns the applied URL state. */
export function LogFilters({
	search,
	onApply,
}: {
	search: LogsSearch
	onApply(search: LogsSearch): void
}) {
	const [opened, setOpened] = useState(false)
	const [draft, setDraft] = useState(search)
	const management = useRuntimeManagementClient()
	const streams = useQuery({
		queryKey: managementQueryKeys.logStreams(),
		queryFn: () => management.logs.streams(),
		enabled: opened,
	})
	const count = [search.stream, search.displayName, search.context, search.category].filter(
		Boolean,
	).length
	return (
		<Popover opened={opened} onChange={setOpened} position="bottom-start" width={320}>
			<Popover.Target>
				<Button
					size="compact-xs"
					variant={count ? 'light' : 'default'}
					onClick={() => {
						setDraft(search)
						setOpened(!opened)
					}}
				>
					筛选{count ? ` · ${count}` : ''}
				</Button>
			</Popover.Target>
			<Popover.Dropdown
				style={{ maxWidth: 'calc(100vw - 24px)', maxHeight: '70dvh', overflowY: 'auto' }}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault()
						onApply(validateLogsSearch(draft))
						setOpened(false)
					}}
				>
					<Stack gap="sm">
						<Autocomplete
							label="日志流"
							value={draft.stream ?? 'default'}
							data={[
								...new Set([
									'default',
									...(streams.data?.streams.map((item) => item.streamId) ?? []),
								]),
							]}
							onChange={(stream) => setDraft({ ...draft, stream })}
						/>
						{streams.isError && (
							<Text size="xs" c="red" role="alert">
								日志流列表读取失败{' '}
								<Button size="compact-xs" variant="subtle" onClick={() => void streams.refetch()}>
									重试
								</Button>
							</Text>
						)}
						<TextInput
							label="显示名称"
							value={draft.displayName ?? ''}
							onChange={(event) => setDraft({ ...draft, displayName: event.currentTarget.value })}
						/>
						<TextInput
							label="上下文"
							value={draft.context ?? ''}
							onChange={(event) => setDraft({ ...draft, context: event.currentTarget.value })}
						/>
						<TextInput
							label="分类"
							placeholder="例如 bot.*"
							value={draft.category ?? ''}
							onChange={(event) => setDraft({ ...draft, category: event.currentTarget.value })}
						/>
						<Group justify="space-between">
							<Button
								size="compact-xs"
								variant="subtle"
								onClick={() => {
									onApply({ plugin: search.plugin })
									setOpened(false)
								}}
							>
								清除附加筛选
							</Button>
							<Button size="compact-xs" type="submit">
								应用筛选
							</Button>
						</Group>
					</Stack>
				</form>
			</Popover.Dropdown>
		</Popover>
	)
}
