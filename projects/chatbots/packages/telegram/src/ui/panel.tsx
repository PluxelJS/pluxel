import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	PasswordInput,
	Select,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web'
import { IconKey, IconPlugConnected, IconPlugX, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { telegramUi } from './runtime.ts'

export function TelegramSettingsPanel() {
	const model = telegramUi.useResources()
	const settingsList = model.settings.useSnapshot().items
	const statusList = model.status.useSnapshot().items
	const [accountId, setAccountId] = useState('default')
	const [token, setToken] = useState('')
	const [apiBase, setApiBase] = useState('https://api.telegram.org')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const settings = settingsList.find((item) => item.id === accountId)
	const status = statusList.find((item) => item.id === accountId)
	useEffect(() => {
		setApiBase(settings?.apiBase ?? 'https://api.telegram.org')
		setToken('')
	}, [settings?.apiBase, accountId])

	const run = async (action: () => Promise<unknown> | unknown, success: string) => {
		setBusy(true)
		try {
			await action()
			setMessage(success)
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, 'Telegram 操作失败'))
		} finally {
			setBusy(false)
		}
	}

	return (
		<Stack gap="md" p="md">
			<Group justify="space-between">
				<div>
					<Title order={4}>Telegram Bot</Title>
					<Text size="sm" c="dimmed">
						Token 仅写入 Pluxel Vault，浏览器不会读回明文。
					</Text>
				</div>
				<Badge
					color={status?.phase === 'online' ? 'green' : status?.phase === 'error' ? 'red' : 'gray'}
				>
					{status?.phase ?? '未配置'}
				</Badge>
			</Group>
			{error || status?.lastError ? <Alert color="red">{error ?? status?.lastError}</Alert> : null}
			{message ? <Alert color="green">{message}</Alert> : null}
			<Card withBorder>
				<Stack>
					<Group grow align="end">
						<Select
							label="已配置账号"
							placeholder="选择或输入新的 Bot ID"
							data={settingsList.map((item) => item.id)}
							value={settings ? accountId : null}
							onChange={(value) => value && setAccountId(value)}
							searchable
							clearable={false}
						/>
						<TextInput
							label="Bot ID"
							description="稳定的本地账号 ID，用于 plugin.bots.require(id)"
							value={accountId}
							onChange={(event) => setAccountId(event.currentTarget.value)}
						/>
					</Group>
					<PasswordInput
						label="Bot Token"
						description={settings ? `已配置：${settings.tokenPreview}` : '尚未配置'}
						value={token}
						onChange={(event) => setToken(event.currentTarget.value)}
						leftSection={<IconKey size={16} />}
					/>
					<TextInput
						label="API Base"
						value={apiBase}
						onChange={(event) => setApiBase(event.currentTarget.value)}
					/>
					<Group>
						<Button
							loading={busy}
							onClick={() =>
								void run(
									() =>
										model.commands.upsertBot({
											id: accountId,
											token: token || undefined,
											apiBase,
										}),
									'设置已保存并连接',
								)
							}
						>
							保存并连接
						</Button>
						<Button
							variant="light"
							leftSection={<IconPlugConnected size={16} />}
							onClick={() =>
								void run(async () => {
									const result = await model.commands.testBot(accountId)
									if (!result.ok) throw new Error(result.message)
								}, '鉴权成功')
							}
						>
							测试
						</Button>
						<Button
							variant="light"
							leftSection={<IconPlugConnected size={16} />}
							onClick={() => void run(() => model.commands.reconnectBot(accountId), '正在重连')}
						>
							重连
						</Button>
						<Button
							variant="light"
							color="gray"
							leftSection={<IconPlugX size={16} />}
							onClick={() => void run(() => model.commands.disconnectBot(accountId), '已断开')}
						>
							断开
						</Button>
						<Button
							variant="light"
							color="red"
							leftSection={<IconTrash size={16} />}
							onClick={() => void run(() => model.commands.removeBot(accountId), 'Bot 已删除')}
						>
							删除 Bot
						</Button>
					</Group>
				</Stack>
			</Card>
			<Text size="sm">
				Bot：{status?.username ? `@${status.username}` : (status?.botId ?? '-')}
			</Text>
			<Text size="xs" c="dimmed">
				Polling offset：{status?.lastUpdateId == null ? '-' : status.lastUpdateId + 1} · 连续失败：
				{status?.consecutiveFailures ?? 0}
				{status?.currentBackoffMs ? ` · 退避 ${status.currentBackoffMs}ms` : ''}
			</Text>
		</Stack>
	)
}
