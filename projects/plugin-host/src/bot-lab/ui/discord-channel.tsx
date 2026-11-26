import { Alert, Button, Group, Loader, Stack, TextInput, Title } from '@mantine/core'
import { WorkbenchMantineProvider } from '@pluxel/workbench/mantine'
import { createWorkbenchRenderer } from '@pluxel/workbench/react'
import { useEffect, useState } from 'react'
import { DiscordBotWorkbench, type DiscordChannelChange } from '../DiscordBot.workbench'

const scope = createWorkbenchRenderer(DiscordBotWorkbench.editor)
const channel = scope.query(({ api }) => ({
	queryKey: ['discord', 'notification-channel'],
	queryFn: () => api.currentDto(),
}))
const saveChannel = scope.mutation(({ api }) => ({
	mutationFn: (input: DiscordChannelChange) => api.saveDto(input),
}))

function DiscordChannel() {
	const { host } = scope.useWorkbench()
	const query = channel.useQuery()
	const save = saveChannel.useMutation()
	const [draft, setDraft] = useState<{ value: string; original: string | null }>()
	const [error, setError] = useState<string>()
	const current = query.data
	const busy = save.isPending || query.isFetching
	const dirty = draft !== undefined && (draft.value || null) !== draft.original
	useEffect(() => {
		host.document?.setDirty(dirty)
	}, [host, dirty])

	async function reload() {
		await query.refetch()
		setDraft(undefined)
		setError(undefined)
	}

	async function submit() {
		if (!draft) return
		try {
			const result = await save.mutateAsync({
				channelId: draft.value || null,
				expectedChannelId: draft.original,
			})
			if (result.ok === false) {
				setError(result.message)
				return
			}
			await reload()
			host.notify({ message: '通知频道已保存', tone: 'success' })
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}

	return (
		<WorkbenchMantineProvider colorScheme={host.colorScheme}>
			<Stack p="lg">
				{query.isPending && <Loader size="sm" />}
				{query.error && (
					<Alert color="red" title="读取通知频道失败">
						{String(query.error)}
					</Alert>
				)}
				{current && (
					<>
						<Title order={2}>{current.name} · Discord 通知频道</Title>
						<TextInput
							label="通知频道 ID"
							description="留空可取消该机器人的通知频道。"
							value={draft?.value ?? current.channelId ?? ''}
							disabled={busy}
							onChange={(event) =>
								setDraft({
									value: event.currentTarget.value,
									original: draft ? draft.original : current.channelId,
								})
							}
						/>
						{error && (
							<Alert color="red" title="操作未完成">
								{error}
							</Alert>
						)}
						<Group>
							<Button
								disabled={!dirty || busy}
								loading={save.isPending}
								onClick={() => void submit()}
							>
								保存频道
							</Button>
							<Button
								variant="subtle"
								disabled={busy}
								onClick={() => void reload().catch((cause) => setError(String(cause)))}
							>
								{dirty ? '放弃修改并重新读取' : '重新读取'}
							</Button>
						</Group>
					</>
				)}
			</Stack>
		</WorkbenchMantineProvider>
	)
}

export default scope.render(DiscordChannel)
