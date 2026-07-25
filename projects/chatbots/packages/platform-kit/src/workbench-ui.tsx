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
import {
	sanitizeTwoPanelLayout,
	useStoredSplitLayout,
	WorkbenchSplitView,
} from '@pluxel/components/workbench-split'
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

const PHASE = {
	offline: { label: '已断开', color: 'gray' },
	connecting: { label: '连接中', color: 'blue' },
	online: { label: '在线', color: 'teal' },
	error: { label: '异常', color: 'red' },
} as const

const ACCOUNT_LIST_PANE = 'chatbots-bot-accounts'
const ACCOUNT_DETAILS_PANE = 'chatbots-bot-details'
const DEFAULT_MANAGER_LAYOUT = {
	[ACCOUNT_LIST_PANE]: 24,
	[ACCOUNT_DETAILS_PANE]: 76,
}

function sanitizeManagerLayout(layout: Record<string, number>) {
	return sanitizeTwoPanelLayout(layout, DEFAULT_MANAGER_LAYOUT, ACCOUNT_LIST_PANE, 18, 52)
}

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
	const managerHref = `/ext/${encodeURIComponent(host.ownerPluginId)}/settings`

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
					<Button component="a" href={`${managerHref}?create=1`} variant="light" size="xs">
						添加 Bot
					</Button>
					<Button component="a" href={managerHref} size="xs">
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
				<Paper withBorder radius="sm" p="md">
					<Text size="sm" fw={600}>
						还没有 {descriptor.name} Bot
					</Text>
					<Text size="xs" c="dimmed" mt={4}>
						添加账号后即可在这里查看连接状态。
					</Text>
				</Paper>
			)}
		</Stack>
	)
}

export function BotAdminManager<Account extends BotAdminAccount<object>>({
	commands,
	state,
	descriptor,
}: BotAdminPanelProps<Account>) {
	const host = useWorkbenchHost()
	const { accounts, connected } = useAccounts(state)
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [creating, setCreating] = useState(
		() => new URLSearchParams(globalThis.location?.search ?? '').get('create') === '1',
	)
	const [search, setSearch] = useState('')
	const [draftId, setDraftId] = useState('default')
	const [token, setToken] = useState('')
	const [apiBase, setApiBase] = useState(descriptor.defaultApiBase)
	const [busy, setBusy] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)
	const selected = creating ? undefined : accounts.find((account) => account.id === selectedId)
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
	const [managerLayout, handleManagerLayoutCommit] = useStoredSplitLayout(
		`pluxel:chatbots:bot-admin:${host.ownerPluginId}`,
		DEFAULT_MANAGER_LAYOUT,
		sanitizeManagerLayout,
	)
	const online = accounts.filter((account) => account.phase === 'online').length
	const issues = accounts.filter((account) => account.phase === 'error').length

	useEffect(() => {
		if (creating || accounts.some((account) => account.id === selectedId)) return
		if (accounts[0]) setSelectedId(accounts[0].id)
		else {
			setCreating(true)
			setSelectedId(null)
		}
	}, [accounts, creating, selectedId])

	useEffect(() => {
		if (creating) return
		setDraftId(selected?.id ?? 'default')
		setApiBase(selected?.apiBase ?? descriptor.defaultApiBase)
		setToken('')
	}, [creating, descriptor.defaultApiBase, selected?.apiBase, selected?.id])

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

	const select = (id: string) => {
		setCreating(false)
		setSelectedId(id)
		setError(null)
	}
	const create = () => {
		setCreating(true)
		setSelectedId(null)
		setDraftId(nextId(accounts))
		setToken('')
		setApiBase(descriptor.defaultApiBase)
		setError(null)
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
			setCreating(false)
			setSelectedId(id)
			setToken('')
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
		if (!confirmed) return
		if (await run('remove', () => commands.removeBot(selected.id), `Bot ${selected.id} 已删除`))
			setSelectedId(accounts.find((account) => account.id !== selected.id)?.id ?? null)
	}
	const canSave = Boolean(draftId.trim() && apiBase.trim() && (selected || token.trim()) && !busy)

	return (
		<Stack gap={0} style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
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

			{error || selected?.lastError ? (
				<Box px={{ base: 'sm', sm: 'md' }} pt="sm">
					<Alert color="red" title="Bot 需要处理">
						{error ?? selected?.lastError}
					</Alert>
				</Box>
			) : null}

			<Box style={{ flex: 1, minHeight: 0 }}>
				<WorkbenchSplitView
					className="chatbots-botAdminSplit"
					layout={managerLayout}
					id={`chatbots-bot-admin-${host.ownerPluginId}`}
					onLayoutCommit={handleManagerLayoutCommit}
					orientation="horizontal"
					primary={{
						id: ACCOUNT_LIST_PANE,
						defaultSize: managerLayout[ACCOUNT_LIST_PANE],
						minSize: 18,
						children: (
							<Stack gap="sm" p="md" style={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
								<Group justify="space-between">
									<Stack gap={0}>
										<Text fw={700}>账号</Text>
										<Text size="xs" c="dimmed">
											{filtered.length === accounts.length
												? `${accounts.length} 个 Bot`
												: `匹配 ${filtered.length} / ${accounts.length}`}
										</Text>
									</Stack>
									<Button size="compact-sm" variant="light" onClick={create}>
										新建
									</Button>
								</Group>
								<TextInput
									placeholder="搜索 Bot ID 或用户名"
									value={search}
									onChange={(event) => setSearch(event.currentTarget.value)}
								/>
								<Stack gap="xs" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
									{filtered.map((account) => (
										<AccountButton
											key={account.id}
											account={account}
											identity={descriptor.identity(account)}
											active={!creating && selectedId === account.id}
											onClick={() => select(account.id)}
										/>
									))}
									{filtered.length === 0 ? (
										<Paper withBorder radius="sm" p="md">
											<Text size="sm" fw={600}>
												{accounts.length === 0 ? `还没有 ${descriptor.name} Bot` : '没有匹配账号'}
											</Text>
											<Text size="xs" c="dimmed" mt={4}>
												{accounts.length === 0
													? '在右侧填写凭据即可创建第一个账号。'
													: '调整搜索条件后重试。'}
											</Text>
										</Paper>
									) : null}
								</Stack>
							</Stack>
						),
					}}
					secondary={{
						id: ACCOUNT_DETAILS_PANE,
						defaultSize: managerLayout[ACCOUNT_DETAILS_PANE],
						minSize: 52,
						children: (
							<Box p="md" style={{ height: '100%', minHeight: 0, overflowY: 'auto' }}>
								<Stack gap="lg">
									<Group justify="space-between" align="flex-start">
										<Stack gap={2}>
											<Title order={4}>
												{creating
													? `新建 ${descriptor.name} Bot`
													: (selected?.id ?? '选择一个 Bot')}
											</Title>
											<Text size="sm" c="dimmed">
												{creating
													? '使用稳定的本地 Bot ID 区分业务用途。'
													: selected
														? descriptor.identity(selected)
														: ''}
											</Text>
										</Stack>
										{selected ? <PhaseBadge phase={selected.phase} /> : null}
									</Group>

									{selected ? descriptor.renderDiagnostics(selected) : null}

									<Paper withBorder radius="sm" p={{ base: 'sm', sm: 'md' }}>
										<form
											onSubmit={(event) => {
												event.preventDefault()
												void save()
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
														onChange={(event) => setDraftId(event.currentTarget.value)}
													/>
													<TextInput
														label="API Base"
														value={apiBase}
														onChange={(event) => setApiBase(event.currentTarget.value)}
													/>
												</SimpleGrid>
												<PasswordInput
													label={selected ? '更换 Bot Token' : 'Bot Token'}
													description={
														selected
															? `当前凭据：${selected.tokenPreview}；留空则保持不变`
															: '创建时必填'
													}
													value={token}
													onChange={(event) => setToken(event.currentTarget.value)}
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
													<Group gap="xs">
														{creating && accounts.length > 0 ? (
															<Button
																variant="subtle"
																color="gray"
																onClick={() => select(accounts[0]!.id)}
															>
																取消
															</Button>
														) : null}
														<Button type="submit" loading={busy === 'save'} disabled={!canSave}>
															{creating ? '创建并连接' : '保存设置'}
														</Button>
													</Group>
												</Group>
											</Stack>
										</form>
									</Paper>

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
														void run(
															'reconnect',
															() => commands.reconnectBot(selected.id),
															'重连已启动',
														)
													}
												>
													重连
												</Button>
												<Button
													variant="light"
													color="gray"
													loading={busy === 'disconnect'}
													onClick={() =>
														void run(
															'disconnect',
															() => commands.disconnectBot(selected.id),
															'Bot 已断开',
														)
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
						),
					}}
				/>
			</Box>
		</Stack>
	)
}

function AccountButton<Account extends BotAdminAccount<object>>({
	account,
	identity,
	active,
	onClick,
}: {
	account: Account
	identity: string
	active: boolean
	onClick: () => void
}) {
	return (
		<UnstyledButton
			aria-pressed={active}
			type="button"
			onClick={onClick}
			style={{
				width: '100%',
				border: `1px solid var(${active ? '--mantine-color-blue-5' : '--mantine-color-default-border'})`,
				borderRadius: 'var(--mantine-radius-sm)',
				padding: 'var(--mantine-spacing-sm)',
				background: active ? 'var(--mantine-color-blue-light)' : 'transparent',
			}}
		>
			<Group justify="space-between" wrap="nowrap">
				<Stack gap={1} style={{ minWidth: 0 }}>
					<Text size="sm" fw={600} truncate>
						{account.id}
					</Text>
					<Text size="xs" c="dimmed" truncate>
						{identity}
					</Text>
				</Stack>
				<PhaseBadge phase={account.phase} />
			</Group>
		</UnstyledButton>
	)
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

function nextId(accounts: readonly BotAdminAccount<object>[]): string {
	if (!accounts.some((account) => account.id === 'default')) return 'default'
	let index = accounts.length + 1
	while (accounts.some((account) => account.id === `bot-${index}`)) index += 1
	return `bot-${index}`
}

function phaseOrder(account: BotAdminAccount<object>): number {
	if (account.phase === 'error') return 0
	if (account.phase === 'connecting') return 1
	if (account.phase === 'online') return 2
	return 3
}
