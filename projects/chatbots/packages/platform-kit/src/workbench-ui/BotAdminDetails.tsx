import {
	Alert,
	Box,
	Button,
	Divider,
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
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { useEffect, useState } from 'react'
import type { BotAdminAccount } from '../bot-admin.ts'
import {
	ManagerHeader,
	openAccountTab,
	PhaseBadge,
	relativeTime,
	useAccounts,
	type BotAdminDescriptor,
	type BotAdminDetailsProps,
} from './shared.tsx'

export function BotAdminDetails<Account extends BotAdminAccount<object>>({
	commands,
	state,
	descriptor,
	mode,
}: BotAdminDetailsProps<Account>) {
	const host = useWorkbenchHost()
	const { accounts, connected } = useAccounts(state)
	const accountId = mode === 'account' ? host.routeParams.accountId : undefined
	const selected = accountId ? accounts.find((account) => account.id === accountId) : undefined
	const [draftId, setDraftId] = useState('default')
	const [token, setToken] = useState('')
	const [apiBase, setApiBase] = useState(descriptor.defaultApiBase)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const creating = mode === 'create'

	useEffect(() => {
		if (creating) return
		setDraftId(selected?.id ?? accountId ?? 'default')
		setApiBase(selected?.apiBase ?? descriptor.defaultApiBase)
		setToken('')
	}, [accountId, creating, descriptor.defaultApiBase, selected?.apiBase, selected?.id])

	const run = async (key: string, action: () => Promise<unknown>, success: string) => {
		setBusy(key)
		try {
			await action()
			setError(null)
			host.notify({ title: descriptor.name, message: success, tone: 'success' })
			return true
		} catch (caught) {
			setError(rpcErrorMessage(caught, `${descriptor.name} 操作失败`))
			return false
		} finally {
			setBusy(null)
		}
	}

	const save = async () => {
		const id = draftId.trim()
		if (
			await run(
				'save',
				() => commands.upsertBot({ id, token: token.trim() || undefined, apiBase: apiBase.trim() }),
				creating ? `Bot ${id} 已创建` : `Bot ${id} 已更新`,
			)
		) {
			setToken('')
			if (creating) openAccountTab(host, descriptor, id)
		}
	}
	const remove = async () => {
		if (!selected) return
		const confirmed = await host.confirm({
			title: `删除 ${selected.id}`,
			message: '该 Bot 的 Vault 凭据和运行实例都会被移除，此操作无法撤销。',
			confirmLabel: '删除 Bot',
			tone: 'danger',
		})
		if (confirmed) {
			await run('remove', () => commands.removeBot(selected.id), `Bot ${selected.id} 已删除`)
		}
	}
	const canSave = Boolean(draftId.trim() && apiBase.trim() && (selected || token.trim()) && !busy)

	return (
		<Stack gap={0} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
			<ManagerHeader accounts={accounts} connected={connected} descriptor={descriptor} />
			<Box p={{ base: 'sm', sm: 'md' }} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
				<Stack gap="lg">
					<Group justify="space-between" align="flex-start">
						<Stack gap={2}>
							<Title order={4}>
								{creating ? `新建 ${descriptor.name} Bot` : (selected?.id ?? accountId ?? 'Bot')}
							</Title>
							<Text size="sm" c="dimmed">
								{creating
									? '使用稳定的本地 Bot ID 区分业务用途。'
									: selected
										? descriptor.identity(selected)
										: '等待账号状态或该账号已被删除。'}
							</Text>
						</Stack>
						{selected ? <PhaseBadge phase={selected.phase} /> : null}
					</Group>

					{error || selected?.lastError ? (
						<Alert color="red" title="Bot 需要处理">
							{error ?? selected?.lastError}
						</Alert>
					) : null}

					{!creating && !selected ? (
						<Alert
							color={connected ? 'yellow' : 'blue'}
							title={connected ? '找不到 Bot' : '正在连接状态流'}
						>
							{connected
								? `账号 ${accountId ?? ''} 不存在或已经被删除。`
								: '连接建立后会自动载入该账号。'}
						</Alert>
					) : null}

					{selected ? descriptor.renderDiagnostics(selected) : null}

					{creating || selected ? (
						<ConnectionForm
							apiBase={apiBase}
							busy={busy}
							canSave={canSave}
							creating={creating}
							descriptor={descriptor}
							draftId={draftId}
							onApiBaseChange={setApiBase}
							onDraftIdChange={setDraftId}
							onSave={save}
							onTokenChange={setToken}
							selected={selected}
							token={token}
						/>
					) : null}

					{selected ? (
						<Stack gap="sm">
							<Group justify="space-between">
								<Text fw={700}>运行控制</Text>
								<Text size="xs" c="dimmed">
									各 Bot 的操作互不阻塞
								</Text>
							</Group>
							<Divider />
							<Group gap="xs">
								<Button
									variant="light"
									loading={busy === 'test'}
									onClick={() =>
										void run(
											'test',
											async () => {
												const result = await commands.testBot(selected.id)
												if (!result.ok) throw new Error(result.message)
											},
											'鉴权测试通过',
										)
									}
								>
									测试鉴权
								</Button>
								<Button
									variant="light"
									loading={busy === 'reconnect'}
									onClick={() =>
										void run('reconnect', () => commands.reconnectBot(selected.id), '重连已启动')
									}
								>
									重连
								</Button>
								<Button
									variant="light"
									color="gray"
									loading={busy === 'disconnect'}
									onClick={() =>
										void run('disconnect', () => commands.disconnectBot(selected.id), 'Bot 已断开')
									}
								>
									断开
								</Button>
								<Button
									variant="subtle"
									color="red"
									loading={busy === 'remove'}
									onClick={() => void remove()}
								>
									删除
								</Button>
							</Group>
						</Stack>
					) : null}
				</Stack>
			</Box>
		</Stack>
	)
}

function ConnectionForm<Account extends BotAdminAccount<object>>({
	apiBase,
	busy,
	canSave,
	creating,
	descriptor,
	draftId,
	onApiBaseChange,
	onDraftIdChange,
	onSave,
	onTokenChange,
	selected,
	token,
}: {
	apiBase: string
	busy: string | null
	canSave: boolean
	creating: boolean
	descriptor: BotAdminDescriptor<Account>
	draftId: string
	onApiBaseChange(value: string): void
	onDraftIdChange(value: string): void
	onSave(): Promise<void>
	onTokenChange(value: string): void
	selected?: Account
	token: string
}) {
	return (
		<Paper withBorder radius="sm" p={{ base: 'sm', sm: 'md' }}>
			<form
				onSubmit={(event) => {
					event.preventDefault()
					void onSave()
				}}
			>
				<Stack gap="md">
					<Stack gap={0}>
						<Text fw={700}>连接设置</Text>
						<Text size="xs" c="dimmed">
							Token 仅写入 Pluxel Vault，状态流只包含掩码。
						</Text>
					</Stack>
					<SimpleGrid cols={{ base: 1, sm: 2 }}>
						<TextInput
							label="Bot ID"
							value={draftId}
							disabled={Boolean(selected)}
							onChange={(event) => onDraftIdChange(event.currentTarget.value)}
						/>
						<TextInput
							label="API Base"
							value={apiBase}
							onChange={(event) => onApiBaseChange(event.currentTarget.value)}
						/>
					</SimpleGrid>
					<PasswordInput
						label={selected ? '更换 Bot Token' : 'Bot Token'}
						description={
							selected ? `当前凭据：${selected.tokenPreview}；留空则保持不变` : '创建时必填'
						}
						value={token}
						onChange={(event) => onTokenChange(event.currentTarget.value)}
					/>
					<Group justify="space-between" align="flex-end" wrap="wrap">
						<Stack gap={0}>
							<Text size="xs" c="dimmed">
								{descriptor.connectHint}
							</Text>
							{selected ? (
								<Text size="xs" c="dimmed">
									状态更新于 {relativeTime(selected.updatedAt)}
								</Text>
							) : null}
						</Stack>
						<Button type="submit" loading={busy === 'save'} disabled={!canSave}>
							{creating ? '创建并连接' : '保存设置'}
						</Button>
					</Group>
				</Stack>
			</form>
		</Paper>
	)
}
