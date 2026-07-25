import {
	Alert,
	Badge,
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
	UnstyledButton,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { BotAdminAccount, BotAdminCommands, BotAdminEvents } from './bot-admin.ts'

type EventClient<Account extends BotAdminAccount<object>> = {
	subscribe(
		event: 'snapshot',
		listener: (snapshot: BotAdminEvents<Account>['snapshot']) => void,
	): () => void
	useConnectionState(): { state: string }
}

export type BotAdminDescriptor<Account extends BotAdminAccount<object>> = {
	name: string
	title: string
	description: string
	defaultApiBase: string
	color: string
	icon: ReactNode
	connectHint: string
	identity(account: Account): string
	renderDiagnostics(account: Account): ReactNode
}

export type BotAdminPanelProps<Account extends BotAdminAccount<object>> = {
	commands: BotAdminCommands
	state: EventClient<Account>
	descriptor: BotAdminDescriptor<Account>
}

export type BotAdminDetailsProps<Account extends BotAdminAccount<object>> =
	BotAdminPanelProps<Account> & { mode: 'account' | 'create' }

const PHASE = {
	offline: { label: '已断开', color: 'gray' },
	connecting: { label: '连接中', color: 'blue' },
	online: { label: '在线', color: 'teal' },
	error: { label: '异常', color: 'red' },
} as const

function useAccounts<Account extends BotAdminAccount<object>>(state: EventClient<Account>) {
	const [accounts, setAccounts] = useState<readonly Account[]>([])
	const connection = state.useConnectionState().state
	useEffect(
		() => state.subscribe('snapshot', (snapshot) => setAccounts(snapshot.accounts)),
		[state],
	)
	return { accounts, connected: connection === 'connected' }
}

export function BotAdminOverview<Account extends BotAdminAccount<object>>({
	state,
	descriptor,
}: BotAdminPanelProps<Account>) {
	const host = useWorkbenchHost()
	const { accounts, connected } = useAccounts(state)
	const ordered = [...accounts].sort(
		(a, b) => phaseOrder(a) - phaseOrder(b) || a.id.localeCompare(b.id),
	)
	const online = accounts.filter((account) => account.phase === 'online').length
	const issues = accounts.filter((account) => account.phase === 'error').length

	return (
		<Stack gap="md" p={{ base: 'sm', sm: 'md' }}>
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<Group gap="sm">
					<Box c={descriptor.color}>{descriptor.icon}</Box>
					<Stack gap={0}>
						<Title order={4}>{descriptor.name}</Title>
						<Text size="xs" c="dimmed">
							Bot 集群运行摘要
						</Text>
					</Stack>
				</Group>
				<Group gap="xs">
					<Badge variant="dot" color={connected ? 'teal' : 'gray'}>
						{connected ? '实时' : '连接中'}
					</Badge>
					<Button variant="light" size="xs" onClick={() => openCreateTab(host, descriptor)}>
						添加 Bot
					</Button>
					<Button size="xs" onClick={() => openManagerTab(host, descriptor)}>
						打开管理台
					</Button>
				</Group>
			</Group>
			<SimpleGrid cols={{ base: 3 }} spacing="sm">
				<Metric label="在线" value={String(online)} />
				<Metric label="异常" value={String(issues)} tone={issues ? 'red' : undefined} />
				<Metric label="已配置" value={String(accounts.length)} />
			</SimpleGrid>
			{ordered.length > 0 ? (
				<Stack gap={0}>
					{ordered.slice(0, 4).map((account, index) => (
						<Box
							key={account.id}
							py="xs"
							style={
								index ? { borderTop: '1px solid var(--mantine-color-default-border)' } : undefined
							}
						>
							<Group justify="space-between" wrap="nowrap">
								<Stack gap={0} style={{ minWidth: 0 }}>
									<Text size="sm" fw={600} truncate>
										{account.id}
									</Text>
									<Text size="xs" c="dimmed" truncate>
										{descriptor.identity(account)}
									</Text>
								</Stack>
								<PhaseBadge phase={account.phase} />
							</Group>
						</Box>
					))}
				</Stack>
			) : (
				<EmptyAccounts descriptor={descriptor} />
			)}
		</Stack>
	)
}

export function BotAdminLauncher<Account extends BotAdminAccount<object>>({
	state,
	descriptor,
}: BotAdminPanelProps<Account>) {
	const host = useWorkbenchHost()
	const { accounts, connected } = useAccounts(state)
	const [search, setSearch] = useState('')
	const filtered = useMemo(() => {
		const needle = search.trim().toLocaleLowerCase()
		return [...accounts]
			.filter(
				(account) =>
					!needle ||
					account.id.toLocaleLowerCase().includes(needle) ||
					account.username?.toLocaleLowerCase().includes(needle),
			)
			.sort((a, b) => a.id.localeCompare(b.id))
	}, [accounts, search])

	return (
		<Stack gap={0} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
			<ManagerHeader accounts={accounts} connected={connected} descriptor={descriptor} />
			<Box p={{ base: 'sm', sm: 'md' }} style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
				<Stack gap="md">
					<Group justify="space-between" align="flex-end" wrap="wrap">
						<Stack gap={2}>
							<Title order={4}>Bot 账号</Title>
							<Text size="sm" c="dimmed">
								选择账号会在 Workbench 中打开独立 Tab。
							</Text>
						</Stack>
						<Button onClick={() => openCreateTab(host, descriptor)}>新建 Bot</Button>
					</Group>
					<TextInput
						placeholder="搜索 Bot ID 或用户名"
						value={search}
						onChange={(event) => setSearch(event.currentTarget.value)}
					/>
					{filtered.length > 0 ? (
						<SimpleGrid cols={{ base: 1, sm: 2, lg: 3, xl: 4 }} spacing="sm">
							{filtered.map((account) => (
								<AccountCard
									key={account.id}
									account={account}
									identity={descriptor.identity(account)}
									onClick={() => openAccountTab(host, descriptor, account.id)}
								/>
							))}
						</SimpleGrid>
					) : accounts.length === 0 ? (
						<EmptyAccounts descriptor={descriptor} />
					) : (
						<Paper withBorder radius="sm" p="lg">
							<Text fw={600}>没有匹配账号</Text>
							<Text size="sm" c="dimmed" mt={4}>
								调整搜索条件后重试。
							</Text>
						</Paper>
					)}
				</Stack>
			</Box>
		</Stack>
	)
}

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

function ManagerHeader<Account extends BotAdminAccount<object>>({
	accounts,
	connected,
	descriptor,
}: {
	accounts: readonly Account[]
	connected: boolean
	descriptor: BotAdminDescriptor<Account>
}) {
	const online = accounts.filter((account) => account.phase === 'online').length
	const issues = accounts.filter((account) => account.phase === 'error').length
	return (
		<Box
			px={{ base: 'sm', sm: 'md' }}
			py="sm"
			style={{ borderBottom: '1px solid var(--mantine-color-default-border)' }}
		>
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<Group gap="sm" align="flex-start">
					<Box c={descriptor.color}>{descriptor.icon}</Box>
					<Stack gap={2}>
						<Title order={3}>{descriptor.title}</Title>
						<Text size="sm" c="dimmed">
							{descriptor.description}
						</Text>
					</Stack>
				</Group>
				<Group gap="xs">
					<Badge variant="dot" color={connected ? 'teal' : 'gray'}>
						{connected ? '实时' : '连接中'}
					</Badge>
					<Badge variant="light" color="teal">
						在线 {online}
					</Badge>
					<Badge variant="light" color={issues > 0 ? 'red' : 'gray'}>
						异常 {issues}
					</Badge>
					<Badge variant="outline" color="gray">
						共 {accounts.length}
					</Badge>
				</Group>
			</Group>
		</Box>
	)
}

function AccountCard<Account extends BotAdminAccount<object>>({
	account,
	identity,
	onClick,
}: {
	account: Account
	identity: string
	onClick: () => void
}) {
	return (
		<UnstyledButton
			type="button"
			onClick={onClick}
			style={{
				width: '100%',
				border: '1px solid var(--mantine-color-default-border)',
				borderRadius: 'var(--mantine-radius-sm)',
				padding: 'var(--mantine-spacing-md)',
				background: 'var(--mantine-color-body)',
			}}
		>
			<Stack gap="sm">
				<Group justify="space-between" wrap="nowrap">
					<Text fw={700} truncate>
						{account.id}
					</Text>
					<PhaseBadge phase={account.phase} />
				</Group>
				<Text size="sm" c="dimmed" truncate>
					{identity}
				</Text>
				<Text size="xs" c="dimmed">
					状态更新于 {relativeTime(account.updatedAt)}
				</Text>
			</Stack>
		</UnstyledButton>
	)
}

function EmptyAccounts<Account extends BotAdminAccount<object>>({
	descriptor,
}: {
	descriptor: BotAdminDescriptor<Account>
}) {
	return (
		<Paper withBorder radius="sm" p="lg">
			<Text fw={600}>还没有 {descriptor.name} Bot</Text>
			<Text size="sm" c="dimmed" mt={4}>
				创建账号后即可查看连接状态和平台诊断。
			</Text>
		</Paper>
	)
}

function openManagerTab(
	host: ReturnType<typeof useWorkbenchHost>,
	descriptor: BotAdminDescriptor<BotAdminAccount<object>>,
) {
	host.openTab({ path: '/settings', title: descriptor.title, meta: 'Bots' })
}

function openCreateTab(
	host: ReturnType<typeof useWorkbenchHost>,
	descriptor: BotAdminDescriptor<BotAdminAccount<object>>,
) {
	host.openTab({ path: '/create', title: `新建 ${descriptor.name} Bot`, meta: descriptor.name })
}

function openAccountTab(
	host: ReturnType<typeof useWorkbenchHost>,
	descriptor: BotAdminDescriptor<BotAdminAccount<object>>,
	accountId: string,
) {
	host.openTab({
		path: `/accounts/${encodeURIComponent(accountId)}`,
		title: accountId,
		meta: `${descriptor.name} Bot`,
	})
}

function PhaseBadge({ phase }: { phase: keyof typeof PHASE }) {
	const meta = PHASE[phase]
	return (
		<Badge size="sm" variant="light" color={meta.color}>
			{meta.label}
		</Badge>
	)
}

export function Metric({ label, value, tone }: { label: string; value: string; tone?: 'red' }) {
	return (
		<Paper withBorder radius="sm" p="sm">
			<Text size="xs" c="dimmed">
				{label}
			</Text>
			<Text fw={700} mt={4} c={tone}>
				{value}
			</Text>
		</Paper>
	)
}

export function relativeTime(value: number | null): string {
	if (!value) return '暂无'
	const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
	if (seconds < 60) return `${seconds} 秒前`
	if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
	return new Intl.DateTimeFormat('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(value)
}

export function durationSince(value: number | null): string {
	if (!value) return '-'
	const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000))
	if (minutes < 60) return `${minutes} 分钟`
	const hours = Math.floor(minutes / 60)
	return hours < 24 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`
}

function phaseOrder(account: BotAdminAccount<object>): number {
	if (account.phase === 'error') return 0
	if (account.phase === 'connecting') return 1
	if (account.phase === 'online') return 2
	return 3
}
