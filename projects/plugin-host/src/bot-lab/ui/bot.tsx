import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	MantineProvider,
	SimpleGrid,
	Stack,
	Text,
	Textarea,
	Title,
} from '@mantine/core'
import { useEffect, useState } from 'react'
import { botScope, botSnapshot, saveBot, setBotRunning } from './bot.scope'

function Bot() {
	const { host } = botScope.useWorkbench()
	const query = botSnapshot.useQuery()
	const save = saveBot.useMutation()
	const running = setBotRunning.useMutation()
	const [draft, setDraft] = useState<{ instructions: string; revision: number }>()
	const [error, setError] = useState<string>()
	const value = query.data
	const dirty = draft !== undefined && draft.instructions !== value?.instructions
	useEffect(() => {
		host.document?.setDirty(dirty)
	}, [host, dirty])
	useEffect(() => {
		if (value)
			host.document?.setTitle({
				title: `${value.name} · ${value.source}`,
				meta: `${value.source}/${value.id}`,
			})
	}, [host, value?.name, value?.source, value?.id])
	const saveDraft = async () => {
		if (!draft || !value) return
		setError(undefined)
		try {
			const result = await save.mutateAsync({
				instructions: draft.instructions,
				expectedRevision: draft.revision,
			})
			if (result.ok === false) {
				setError(`${result.code}：${result.message}`)
				return
			}
			await query.refetch()
			setDraft(undefined)
			host.notify({ message: '机器人配置已保存', tone: 'success' })
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}
	const reload = async () => {
		try {
			await query.refetch()
			setDraft(undefined)
			setError(undefined)
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}
	const toggleRunning = async () => {
		if (!value) return
		setError(undefined)
		try {
			const result = await running.mutateAsync({
				running: !value.running,
				expectedRevision: value.revision,
			})
			if (result.ok === false) setError(`${result.code}：${result.message}`)
			else await query.refetch()
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause))
		}
	}
	return (
		<MantineProvider forceColorScheme={host.colorScheme}>
			<Stack p="md" gap="sm">
				{query.isPending && <Loader size="sm" />}
				{query.error && (
					<Alert color="red" title="读取机器人失败">
						{query.error instanceof Error ? query.error.message : String(query.error)}
					</Alert>
				)}
				{value && (
					<>
						<Group justify="space-between">
							<div>
								<Title order={2} size="h3">
									{value.name}
								</Title>
								<Text size="xs" c="dimmed">
									{value.source} / {value.id} · {value.account}
								</Text>
							</div>
							<Group gap={6}>
								<Badge color="yellow" variant="light">
									模拟
								</Badge>
								<Badge color={!value.available ? 'orange' : value.running ? 'teal' : 'gray'}>
									{!value.available ? '来源不可用' : value.running ? '运行中' : '已停止'}
								</Badge>
							</Group>
						</Group>
						{!value.available && (
							<Alert color="orange">当前来源不可用，仍可查看已知详情；写入与启停不可用。</Alert>
						)}
						{error && (
							<Alert
								color="red"
								title="操作未完成"
								withCloseButton
								onClose={() => setError(undefined)}
							>
								{error}
							</Alert>
						)}
						{dirty && draft?.revision !== value.revision && (
							<Alert color="yellow">
								此机器人已在其他位置更新。当前草稿保持不变，保存将检查版本；请先核对，或放弃草稿后重新编辑。
							</Alert>
						)}
						<SimpleGrid cols={{ base: 1, md: 2 }} spacing="sm">
							<Card withBorder padding="sm">
								<Stack gap="sm">
									<Group justify="space-between">
										<Text fw={600}>配置</Text>
										<Text size="xs" c="dimmed">
											版本 {value.revision}
										</Text>
									</Group>
									<Textarea
										label="机器人指令"
										description="该输入只属于当前文档，保存前不会影响其他标签。"
										minRows={7}
										autosize
										maxRows={16}
										value={draft?.instructions ?? value.instructions}
										disabled={!value.available || save.isPending}
										onChange={(event) =>
											setDraft({
												instructions: event.currentTarget.value,
												revision: draft?.revision ?? value.revision,
											})
										}
									/>
									<Group gap={6}>
										<Button
											size="xs"
											onClick={() => void saveDraft()}
											disabled={!dirty || !value.available || running.isPending}
											loading={save.isPending}
										>
											保存配置
										</Button>
										<Button
											size="xs"
											variant="subtle"
											disabled={!draft || save.isPending}
											onClick={() => void reload()}
										>
											放弃草稿并重新读取
										</Button>
									</Group>
									<Text size="xs" c="dimmed">
										{value.capability}
									</Text>
								</Stack>
							</Card>
							<Card withBorder padding="sm">
								<Stack gap="sm">
									<Group justify="space-between">
										<Text fw={600}>运行与会话</Text>
										<Button
											size="compact-xs"
											variant="light"
											loading={running.isPending}
											disabled={!value.available || dirty || save.isPending}
											onClick={() => void toggleRunning()}
										>
											{value.running ? '停止' : '启动'}
										</Button>
									</Group>
									<Group>
										<Text size="sm">消息 {value.messages}</Text>
										<Text size="sm">未读 {value.unread}</Text>
										<Text size="sm">分组 {value.group}</Text>
									</Group>
									<Text fw={600} size="sm">
										该机器人的事件
									</Text>
									{value.events.length > 0 ? (
										value.events.map((event, index) => (
											<div key={`${event.at}:${index}`}>
												<Text size="xs">{event.message}</Text>
												<Text size="10px" c="dimmed">
													{event.at}
												</Text>
											</div>
										))
									) : (
										<Text size="xs" c="dimmed">
											暂无事件
										</Text>
									)}
								</Stack>
							</Card>
						</SimpleGrid>
					</>
				)}
			</Stack>
		</MantineProvider>
	)
}
export default botScope.render(Bot)
