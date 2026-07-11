import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	PasswordInput,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web/ui'
import { IconKey, IconPlugConnected, IconPlugX, IconTrash } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import type { KookSettingsDoc, KookStatusDoc } from '../index.ts'
import { kookPlugin } from './runtime.ts'

type KookUiApp = {
	rpc: {
		saveSettings(input: { token?: string; apiBase?: string }): Promise<KookSettingsDoc>
		clearToken(): Promise<KookSettingsDoc>
		testConnection(): Promise<{ ok: boolean; message: string }>
		reconnect(): Promise<KookStatusDoc>
		disconnect(): Promise<KookStatusDoc>
	}
	db: {
		useDocById(collection: 'settings', id: 'settings'): KookSettingsDoc | undefined
		useDocById(collection: 'status', id: 'status'): KookStatusDoc | undefined
	}
}

export function KookSettingsPanel() {
	const app = kookPlugin.use() as unknown as KookUiApp
	const settings = app.db.useDocById('settings', 'settings')
	const status = app.db.useDocById('status', 'status')
	const [token, setToken] = useState('')
	const [apiBase, setApiBase] = useState('https://www.kookapp.cn')
	const [busy, setBusy] = useState(false)
	const [message, setMessage] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	useEffect(() => setApiBase(settings?.apiBase ?? 'https://www.kookapp.cn'), [settings?.apiBase])

	const run = async (action: () => Promise<unknown>, success: string) => {
		setBusy(true)
		try {
			await action()
			setMessage(success)
			setError(null)
		} catch (caught) {
			setError(rpcErrorMessage(caught, 'KOOK 操作失败'))
		} finally {
			setBusy(false)
		}
	}

	return (
		<Stack gap="md" p="md">
			<Group justify="space-between">
				<div>
					<Title order={4}>KOOK Bot</Title>
					<Text size="sm" c="dimmed">
						Token 仅写入 Pluxel Vault，浏览器不会读回明文。
					</Text>
				</div>
				<Badge
					color={status?.phase === 'online' ? 'green' : status?.phase === 'error' ? 'red' : 'gray'}
				>
					{status?.phase ?? 'loading'}
				</Badge>
			</Group>
			{error || status?.lastError ? <Alert color="red">{error ?? status?.lastError}</Alert> : null}
			{message ? <Alert color="green">{message}</Alert> : null}
			<Card withBorder>
				<Stack>
					<PasswordInput
						label="Bot Token"
						description={settings?.hasToken ? `已配置：${settings.tokenPreview}` : '尚未配置'}
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
									() => app.rpc.saveSettings({ token: token || undefined, apiBase }),
									'设置已保存并连接',
								)
							}
						>
							保存并连接
						</Button>
						<Button
							variant="light"
							leftSection={<IconPlugConnected size={16} />}
							onClick={() => void run(() => app.rpc.testConnection(), '鉴权成功')}
						>
							测试
						</Button>
						<Button
							variant="light"
							leftSection={<IconPlugConnected size={16} />}
							onClick={() => void run(() => app.rpc.reconnect(), '正在重连')}
						>
							重连
						</Button>
						<Button
							variant="light"
							color="gray"
							leftSection={<IconPlugX size={16} />}
							onClick={() => void run(() => app.rpc.disconnect(), '已断开')}
						>
							断开
						</Button>
						<Button
							variant="light"
							color="red"
							leftSection={<IconTrash size={16} />}
							onClick={() => void run(() => app.rpc.clearToken(), 'Token 已删除')}
						>
							删除 Token
						</Button>
					</Group>
				</Stack>
			</Card>
			<Text size="sm">Bot：{status?.username ?? status?.botId ?? '-'}</Text>
		</Stack>
	)
}
