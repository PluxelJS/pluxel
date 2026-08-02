import {
	Alert,
	Badge,
	Box,
	Button,
	Group,
	Paper,
	PasswordInput,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web'
import { createWorkbenchUi } from '@pluxel/runtime/workbench/ui'
import { IconBrandDiscord } from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import { DiscordUi, type DiscordAdminAccount } from './contract.ts'

const ui = createWorkbenchUi(DiscordUi)

export default ui.define({ Manager: DiscordManager })

function DiscordManager() {
	const { commands, state } = ui.useResources()
	const [accounts, setAccounts] = useState<readonly DiscordAdminAccount[]>([])
	const [id, setId] = useState('default')
	const [token, setToken] = useState('')
	const [busy, setBusy] = useState<string>()
	const [error, setError] = useState<string>()
	useEffect(
		() => state.subscribe('snapshot', (snapshot) => setAccounts(snapshot.accounts)),
		[state],
	)

	const run = async (key: string, action: () => Promise<void>) => {
		setBusy(key)
		try {
			await action()
			setError(undefined)
		} catch (caught) {
			setError(rpcErrorMessage(caught, 'Discord Bot 操作失败'))
		} finally {
			setBusy(undefined)
		}
	}

	return (
		<Stack gap={0} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
			<Group
				justify="space-between"
				px={{ base: 'sm', sm: 'md' }}
				py="sm"
				style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
			>
				<Group gap="sm">
					<IconBrandDiscord size={28} />
					<Stack gap={0}>
						<Title order={3}>Discord Bots</Title>
						<Text size="sm" c="dimmed">
							Token 只写入 Pluxel Vault；Gateway 仅启用 Guilds 与 GuildVoiceStates。
						</Text>
					</Stack>
				</Group>
				<Badge variant="light">{accounts.length} 个 Bot</Badge>
			</Group>
			<Box p={{ base: 'sm', sm: 'md' }} style={{ overflowY: 'auto' }}>
				<Stack gap="lg">
					{error ? <Alert color="red">{error}</Alert> : null}
					<Paper withBorder p="md">
						<Stack gap="sm">
							<Text fw={700}>添加或更新 Bot</Text>
							<Group align="flex-end" grow>
								<TextInput
									label="本地 Bot ID"
									value={id}
									onChange={(e) => setId(e.currentTarget.value)}
								/>
								<PasswordInput
									label="Bot Token"
									placeholder="更新已有 Bot 时可留空"
									value={token}
									onChange={(e) => setToken(e.currentTarget.value)}
								/>
								<Button
									loading={busy === 'save'}
									disabled={!id.trim() || Boolean(busy)}
									onClick={() =>
										void run('save', async () => {
											await commands.upsertBot({ id: id.trim(), token: token.trim() || undefined })
											setToken('')
										})
									}
								>
									保存并连接
								</Button>
							</Group>
						</Stack>
					</Paper>
					<SimpleGrid cols={{ base: 1, md: 2, xl: 3 }}>
						{accounts.map((account) => (
							<AccountCard
								key={account.id}
								account={account}
								busy={busy}
								run={run}
								commands={commands}
							/>
						))}
					</SimpleGrid>
				</Stack>
			</Box>
		</Stack>
	)
}

function AccountCard({
	account,
	busy,
	run,
	commands,
}: {
	account: DiscordAdminAccount
	busy?: string
	run(key: string, action: () => Promise<void>): Promise<void>
	commands: ReturnType<typeof ui.useResources>['commands']
}) {
	const key = (action: string) => `${account.id}:${action}`
	return (
		<Paper withBorder p="md">
			<Stack gap="sm">
				<Group justify="space-between">
					<Text fw={700}>{account.id}</Text>
					<Badge
						color={account.state === 'ready' ? 'teal' : account.state === 'failed' ? 'red' : 'gray'}
					>
						{account.state}
					</Badge>
				</Group>
				<Text size="sm">
					{account.username ?? '尚未鉴权'} · {account.guilds} 个服务器
				</Text>
				<Text size="xs" c="dimmed">
					Token {account.tokenPreview}
				</Text>
				{account.failureMessage ? <Alert color="red">{account.failureMessage}</Alert> : null}
				<Group gap="xs">
					<Button
						size="xs"
						variant="light"
						loading={busy === key('reconnect')}
						onClick={() => void run(key('reconnect'), () => commands.reconnectBot(account.id))}
					>
						重连
					</Button>
					<Button
						size="xs"
						variant="light"
						color="gray"
						loading={busy === key('disconnect')}
						onClick={() => void run(key('disconnect'), () => commands.disconnectBot(account.id))}
					>
						断开
					</Button>
					<Button
						size="xs"
						variant="subtle"
						color="red"
						loading={busy === key('remove')}
						onClick={() => void run(key('remove'), () => commands.removeBot(account.id))}
					>
						删除
					</Button>
				</Group>
			</Stack>
		</Paper>
	)
}
