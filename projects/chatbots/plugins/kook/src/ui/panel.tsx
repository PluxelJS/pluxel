import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Divider,
	Grid,
	Group,
	Loader,
	Paper,
	PasswordInput,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
	Tooltip,
	UnstyledButton,
} from '@mantine/core'
import { rpcErrorMessage } from '@pluxel/runtime/web'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import {
	IconActivity,
	IconAlertTriangle,
	IconBrandDiscord,
	IconCheck,
	IconClock,
	IconExternalLink,
	IconKey,
	IconPlus,
	IconPlugConnected,
	IconPlugX,
	IconRefresh,
	IconRobot,
	IconTrash,
} from '@tabler/icons-react'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type { KookSettingsDoc, KookStatusDoc } from '../workbench-contract.ts'
import { kookUi } from './runtime.ts'

const DEFAULT_API_BASE = 'https://www.kookapp.cn'

const PHASE_META = {
	offline: { label: '已断开', color: 'gray' },
	connecting: { label: '连接中', color: 'blue' },
	online: { label: '在线', color: 'teal' },
	error: { label: '异常', color: 'red' },
} as const

const GATEWAY_LABEL: Record<KookStatusDoc['gatewayPhase'], string> = {
	idle: '待机',
	connecting: '连接中',
	resuming: '恢复会话',
	online: '在线',
	backoff: '退避中',
	stopped: '已停止',
}

export function KookOverviewPanel() {
	const model = kookUi.useResources()
	const host = useWorkbenchHost()
	const settingsQuery = model.settings.useQuery()
	const statusQuery = model.status.useQuery()
	const statuses = settingsQuery.rows
		.map((settings) => ({
			settings,
			status: statusQuery.rows.find((item) => item.id === settings.id),
		}))
		.sort((left, right) => phaseOrder(left.status) - phaseOrder(right.status))
	const onlineCount = statuses.filter((item) => item.status?.phase === 'online').length
	const issueCount = statuses.filter((item) => item.status?.phase === 'error').length
	const managerHref = `/ext/${encodeURIComponent(host.ownerPluginId)}/settings`
	const queryError = settingsQuery.error ?? statusQuery.error

	return (
		<Stack gap="md" p={{ base: 'sm', sm: 'md' }}>
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<Group gap="sm">
					<Box c="violet.6">
						<IconBrandDiscord size={24} />
					</Box>
					<Stack gap={0}>
						<Title order={4}>KOOK</Title>
						<Text size="xs" c="dimmed">
							Bot 集群运行摘要
						</Text>
					</Stack>
				</Group>
				<Group gap="xs">
					<Button
						component="a"
						href={`${managerHref}?create=1`}
						variant="light"
						size="xs"
						leftSection={<IconPlus size={14} />}
					>
						添加 Bot
					</Button>
					<Button
						component="a"
						href={managerHref}
						size="xs"
						rightSection={<IconExternalLink size={14} />}
					>
						打开管理台
					</Button>
				</Group>
			</Group>
			{queryError ? <Alert color="red">状态读取失败：{queryError.message}</Alert> : null}
			<SimpleGrid cols={{ base: 3 }} spacing="sm">
				<Metric label="在线" value={String(onlineCount)} />
				<Metric label="异常" value={String(issueCount)} tone={issueCount ? 'red' : undefined} />
				<Metric label="已配置" value={String(settingsQuery.rows.length)} />
			</SimpleGrid>
			{statuses.length ? (
				<Stack gap={0}>
					{statuses.slice(0, 4).map(({ settings, status }, index) => {
						const phase = PHASE_META[status?.phase ?? 'offline']
						return (
							<Box
								key={settings.id}
								py="xs"
								style={
									index ? { borderTop: '1px solid var(--mantine-color-default-border)' } : undefined
								}
							>
								<Group justify="space-between" wrap="nowrap">
									<Stack gap={0} style={{ minWidth: 0 }}>
										<Text size="sm" fw={600} truncate>
											{settings.id}
										</Text>
										<Text size="xs" c="dimmed" truncate>
											{status?.username ?? '尚未鉴权'}
										</Text>
									</Stack>
									<Group gap="xs" wrap="nowrap">
										<Text size="xs" c="dimmed">
											{status ? GATEWAY_LABEL[status.gatewayPhase] : '待机'}
										</Text>
										<Badge size="xs" variant="light" color={phase.color}>
											{phase.label}
										</Badge>
									</Group>
								</Group>
							</Box>
						)
					})}
					{statuses.length > 4 ? (
						<Text size="xs" c="dimmed" ta="center" pt="xs">
							其余 {statuses.length - 4} 个 Bot 请在管理台查看
						</Text>
					) : null}
				</Stack>
			) : (
				<Paper withBorder radius="sm" p="md">
					<Text size="sm" fw={600}>
						还没有 KOOK Bot
					</Text>
					<Text size="xs" c="dimmed" mt={4}>
						从这里快捷添加，完整配置和 Gateway 诊断在独立管理台中完成。
					</Text>
				</Paper>
			)}
		</Stack>
	)
}

export function KookManagerPanel() {
	const model = kookUi.useResources()
	const host = useWorkbenchHost()
	const settingsQuery = model.settings.useQuery()
	const statusQuery = model.status.useQuery()
	const settingsList = settingsQuery.rows
	const statusList = statusQuery.rows
	const [selectedId, setSelectedId] = useState<string | null>(null)
	const [creating, setCreating] = useState(
		() => new URLSearchParams(globalThis.location?.search ?? '').get('create') === '1',
	)
	const [search, setSearch] = useState('')
	const [draftId, setDraftId] = useState('default')
	const [token, setToken] = useState('')
	const [apiBase, setApiBase] = useState(DEFAULT_API_BASE)
	const [busyAction, setBusyAction] = useState<string | null>(null)
	const [error, setError] = useState<string | null>(null)

	const accounts = useMemo(
		() =>
			settingsList
				.map((settings) => ({
					settings,
					status: statusList.find((item) => item.id === settings.id),
				}))
				.sort((left, right) => left.settings.id.localeCompare(right.settings.id)),
		[settingsList, statusList],
	)
	const filteredAccounts = accounts.filter(({ settings, status }) => {
		const needle = search.trim().toLocaleLowerCase()
		return (
			!needle ||
			settings.id.toLocaleLowerCase().includes(needle) ||
			status?.username?.toLocaleLowerCase().includes(needle)
		)
	})
	const selectedSettings = creating
		? undefined
		: settingsList.find((item) => item.id === selectedId)
	const selectedStatus = creating ? undefined : statusList.find((item) => item.id === selectedId)
	const onlineCount = statusList.filter((item) => item.phase === 'online').length
	const issueCount = statusList.filter((item) => item.phase === 'error').length

	useEffect(() => {
		if (creating || !settingsList[0] || settingsList.some((item) => item.id === selectedId)) return
		setSelectedId(settingsList[0].id)
	}, [creating, selectedId, settingsList])

	useEffect(() => {
		if (creating) return
		setDraftId(selectedSettings?.id ?? 'default')
		setApiBase(selectedSettings?.apiBase ?? DEFAULT_API_BASE)
		setToken('')
	}, [creating, selectedSettings?.apiBase, selectedSettings?.id])

	const run = async (
		key: string,
		action: () => Promise<unknown>,
		success: string,
	): Promise<boolean> => {
		setBusyAction(key)
		try {
			await action()
			setError(null)
			host.notify({ title: 'KOOK', message: success, tone: 'success' })
			return true
		} catch (caught) {
			setError(rpcErrorMessage(caught, 'KOOK 操作失败'))
			return false
		} finally {
			setBusyAction(null)
		}
	}

	const selectAccount = (id: string) => {
		setCreating(false)
		setSelectedId(id)
		setError(null)
	}

	const startCreate = () => {
		setCreating(true)
		setSelectedId(null)
		setDraftId(nextAccountId(settingsList))
		setToken('')
		setApiBase(DEFAULT_API_BASE)
		setError(null)
	}

	const save = async () => {
		const id = draftId.trim()
		const saved = await run(
			'save',
			() =>
				model.commands.upsertBot({ id, token: token.trim() || undefined, apiBase: apiBase.trim() }),
			creating ? `Bot ${id} 已创建并开始连接` : `Bot ${id} 设置已更新`,
		)
		if (!saved) return
		setCreating(false)
		setSelectedId(id)
		setToken('')
	}

	const remove = async () => {
		if (!selectedSettings) return
		const confirmed = await host.confirm({
			title: `删除 ${selectedSettings.id}`,
			message: '该 Bot 的 Vault 凭据和 Gateway 实例都会被移除，此操作无法撤销。',
			confirmLabel: '删除 Bot',
			tone: 'danger',
		})
		if (!confirmed) return
		const id = selectedSettings.id
		const removed = await run('remove', () => model.commands.removeBot(id), `Bot ${id} 已删除`)
		if (!removed) return
		setSelectedId(settingsList.find((item) => item.id !== id)?.id ?? null)
	}

	const refresh = (): void =>
		void run(
			'refresh',
			() => Promise.all([model.settings.refresh(), model.status.refresh()]),
			'账号状态已刷新',
		)

	const queryError = settingsQuery.error ?? statusQuery.error
	const isLoading = settingsQuery.state === 'loading' || statusQuery.state === 'loading'
	const isStale = settingsQuery.state === 'stale' || statusQuery.state === 'stale'
	const canSave = Boolean(
		draftId.trim() && apiBase.trim() && (selectedSettings || token.trim()) && !busyAction,
	)

	return (
		<Stack gap="lg" p={{ base: 'sm', sm: 'md' }}>
			<Group justify="space-between" align="flex-start" wrap="wrap">
				<Group gap="sm" align="flex-start">
					<Box c="violet.6" mt={2}>
						<IconBrandDiscord size={28} />
					</Box>
					<Stack gap={2}>
						<Title order={3}>KOOK Bots</Title>
						<Text size="sm" c="dimmed">
							集中管理多个 Bot 的凭据、Gateway 连接和会话恢复
						</Text>
					</Stack>
				</Group>
				<Group gap="xs">
					<Badge variant="light" color="teal">
						在线 {onlineCount}
					</Badge>
					<Badge variant="light" color={issueCount ? 'red' : 'gray'}>
						异常 {issueCount}
					</Badge>
					<Badge variant="outline" color="gray">
						共 {settingsList.length}
					</Badge>
					<Tooltip label="刷新状态">
						<ActionIcon
							variant="subtle"
							color="gray"
							aria-label="刷新状态"
							loading={busyAction === 'refresh'}
							onClick={refresh}
						>
							<IconRefresh size={18} />
						</ActionIcon>
					</Tooltip>
				</Group>
			</Group>

			{queryError ? (
				<Alert color="red" title="无法获取 Bot 数据">
					{queryError.message}
				</Alert>
			) : null}
			{isStale ? <Alert color="yellow">当前显示上一次成功读取的数据，后台正在重试。</Alert> : null}
			{error || selectedStatus?.lastError ? (
				<Alert color="red" title="Bot 需要处理" icon={<IconAlertTriangle size={18} />}>
					{error ?? selectedStatus?.lastError}
				</Alert>
			) : null}

			<Grid gap="lg" align="flex-start">
				<Grid.Col span={{ base: 12, md: 4, lg: 3 }}>
					<Stack gap="sm">
						<Group justify="space-between">
							<Text fw={600} size="sm">
								账号
							</Text>
							<Button
								size="compact-sm"
								variant="light"
								leftSection={<IconPlus size={15} />}
								onClick={startCreate}
							>
								新建
							</Button>
						</Group>
						<TextInput
							placeholder="搜索 Bot ID 或用户名"
							value={search}
							onChange={(event) => setSearch(event.currentTarget.value)}
						/>
						{isLoading && !settingsList.length ? <Loader size="sm" /> : null}
						{!isLoading && !filteredAccounts.length ? (
							<Paper withBorder p="md" radius="sm">
								<Text size="sm" fw={600}>
									{search ? '没有匹配账号' : '还没有 Bot'}
								</Text>
								<Text size="xs" c="dimmed" mt={4}>
									{search ? '尝试其他关键词。' : '创建第一个账号后，这里会显示它的连接状态。'}
								</Text>
							</Paper>
						) : null}
						{filteredAccounts.map(({ settings, status }) => (
							<AccountButton
								key={settings.id}
								settings={settings}
								status={status}
								active={!creating && selectedId === settings.id}
								onClick={() => selectAccount(settings.id)}
							/>
						))}
					</Stack>
				</Grid.Col>

				<Grid.Col span={{ base: 12, md: 8, lg: 9 }}>
					<Stack gap="lg">
						<AccountHeader
							settings={selectedSettings}
							status={selectedStatus}
							creating={creating}
						/>
						{selectedSettings && selectedStatus ? (
							<>
								<SimpleGrid cols={{ base: 2, sm: 4 }} spacing="sm">
									<Metric
										label="Gateway"
										value={GATEWAY_LABEL[selectedStatus.gatewayPhase]}
										icon={<IconActivity size={16} />}
										tone={selectedStatus.gatewayPhase === 'backoff' ? 'red' : undefined}
									/>
									<Metric label="已确认序列" value={String(selectedStatus.lastSequence)} />
									<Metric
										label="最近事件"
										value={relativeTime(selectedStatus.lastEventAt)}
										icon={<IconClock size={16} />}
									/>
									<Metric label="连接时长" value={durationSince(selectedStatus.connectedAt)} />
								</SimpleGrid>
								<Paper withBorder radius="sm" p="sm">
									<Group justify="space-between" mb="xs">
										<Text fw={600} size="sm">
											Gateway 诊断
										</Text>
										<Text size="xs" c="dimmed">
											最后 Pong {relativeTime(selectedStatus.lastPongAt)}
										</Text>
									</Group>
									<SimpleGrid cols={{ base: 2, sm: 4 }} spacing="xs">
										<Diagnostic label="事件" value={selectedStatus.eventsReceived} />
										<Diagnostic
											label="连接 / 重连"
											value={`${selectedStatus.connectAttempts} / ${selectedStatus.reconnectAttempts}`}
										/>
										<Diagnostic label="Resume" value={selectedStatus.resumeAttempts} />
										<Diagnostic
											label="Ping / Pong"
											value={`${selectedStatus.pingSent} / ${selectedStatus.pongReceived}`}
										/>
										<Diagnostic
											label="当前缓冲"
											value={selectedStatus.bufferedEvents}
											warn={selectedStatus.bufferedEvents > 0}
										/>
										<Diagnostic
											label="乱序 / 重复"
											value={`${selectedStatus.outOfOrderEvents} / ${selectedStatus.duplicateEvents}`}
											warn={selectedStatus.outOfOrderEvents > 0}
										/>
										<Diagnostic
											label="缓冲溢出"
											value={selectedStatus.bufferOverflows}
											warn={selectedStatus.bufferOverflows > 0}
										/>
										<Diagnostic
											label="当前退避"
											value={
												selectedStatus.currentBackoffMs
													? `${selectedStatus.currentBackoffMs} ms`
													: '-'
											}
											warn={selectedStatus.currentBackoffMs > 0}
										/>
									</SimpleGrid>
								</Paper>
							</>
						) : null}

						<Paper withBorder radius="sm" p={{ base: 'sm', sm: 'md' }}>
							<form
								onSubmit={(event) => {
									event.preventDefault()
									void save()
								}}
							>
								<Stack gap="md">
									<Stack gap={2}>
										<Text fw={600}>{creating ? '创建 Bot' : '连接设置'}</Text>
										<Text size="xs" c="dimmed">
											Token 仅写入 Pluxel Vault，页面不会读回明文。
										</Text>
									</Stack>
									<SimpleGrid cols={{ base: 1, sm: 2 }}>
										<TextInput
											label="Bot ID"
											description="稳定的本地 ID，供 bots.require(id) 寻址"
											value={draftId}
											disabled={Boolean(selectedSettings)}
											onChange={(event) => setDraftId(event.currentTarget.value)}
										/>
										<TextInput
											label="API Base"
											description="通常无需修改"
											value={apiBase}
											onChange={(event) => setApiBase(event.currentTarget.value)}
										/>
									</SimpleGrid>
									<PasswordInput
										label={selectedSettings ? '更换 Bot Token' : 'Bot Token'}
										description={
											selectedSettings
												? `当前凭据：${selectedSettings.tokenPreview}；留空则保持不变`
												: '创建时必填'
										}
										value={token}
										onChange={(event) => setToken(event.currentTarget.value)}
										leftSection={<IconKey size={16} />}
									/>
									<Group justify="space-between" align="center" wrap="wrap">
										<Text size="xs" c="dimmed">
											{selectedSettings
												? `配置更新于 ${formatTime(selectedSettings.updatedAt)}`
												: '保存后将验证身份并建立 Gateway'}
										</Text>
										<Group gap="xs">
											{creating && settingsList.length ? (
												<Button
													variant="subtle"
													color="gray"
													onClick={() => selectAccount(settingsList[0].id)}
												>
													取消
												</Button>
											) : null}
											<Button
												type="submit"
												loading={busyAction === 'save'}
												disabled={!canSave}
												leftSection={<IconCheck size={16} />}
											>
												{creating ? '创建并连接' : '保存设置'}
											</Button>
										</Group>
									</Group>
								</Stack>
							</form>
						</Paper>

						{selectedSettings ? (
							<Stack gap="sm">
								<Group justify="space-between">
									<Text fw={600}>运行控制</Text>
									<Text size="xs" c="dimmed">
										各 Bot 的操作互不阻塞
									</Text>
								</Group>
								<Divider />
								<Group gap="xs">
									<Button
										variant="light"
										loading={busyAction === 'test'}
										leftSection={<IconCheck size={16} />}
										onClick={() =>
											void run(
												'test',
												async () => {
													const result = await model.commands.testBot(selectedSettings.id)
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
										loading={busyAction === 'reconnect'}
										leftSection={<IconPlugConnected size={16} />}
										onClick={() =>
											void run(
												'reconnect',
												() => model.commands.reconnectBot(selectedSettings.id),
												'重连已启动',
											)
										}
									>
										重连
									</Button>
									<Button
										variant="light"
										color="gray"
										loading={busyAction === 'disconnect'}
										leftSection={<IconPlugX size={16} />}
										onClick={() =>
											void run(
												'disconnect',
												() => model.commands.disconnectBot(selectedSettings.id),
												'Bot 已断开',
											)
										}
									>
										断开
									</Button>
									<Button
										variant="subtle"
										color="red"
										loading={busyAction === 'remove'}
										leftSection={<IconTrash size={16} />}
										onClick={() => void remove()}
									>
										删除
									</Button>
								</Group>
							</Stack>
						) : null}
					</Stack>
				</Grid.Col>
			</Grid>
		</Stack>
	)
}

function AccountButton({
	settings,
	status,
	active,
	onClick,
}: {
	settings: KookSettingsDoc
	status?: KookStatusDoc
	active: boolean
	onClick: () => void
}) {
	const phase = PHASE_META[status?.phase ?? 'offline']
	return (
		<UnstyledButton
			onClick={onClick}
			style={{
				width: '100%',
				border: `1px solid var(${active ? '--mantine-color-violet-5' : '--mantine-color-default-border'})`,
				borderRadius: 'var(--mantine-radius-sm)',
				padding: 'var(--mantine-spacing-sm)',
				background: active ? 'var(--mantine-color-violet-light)' : 'transparent',
			}}
		>
			<Group justify="space-between" wrap="nowrap" align="flex-start">
				<Group gap="sm" wrap="nowrap" style={{ minWidth: 0 }}>
					<Box c={active ? 'violet.7' : 'dimmed'}>
						<IconRobot size={19} />
					</Box>
					<Stack gap={1} style={{ minWidth: 0 }}>
						<Text size="sm" fw={600} truncate>
							{settings.id}
						</Text>
						<Text size="xs" c="dimmed" truncate>
							{status?.username ?? status?.botId ?? '尚未鉴权'}
						</Text>
					</Stack>
				</Group>
				<Badge size="xs" variant="light" color={phase.color}>
					{phase.label}
				</Badge>
			</Group>
		</UnstyledButton>
	)
}

function AccountHeader({
	settings,
	status,
	creating,
}: {
	settings?: KookSettingsDoc
	status?: KookStatusDoc
	creating: boolean
}) {
	const phase = PHASE_META[status?.phase ?? 'offline']
	return (
		<Group justify="space-between" align="flex-start" wrap="wrap">
			<Stack gap={2}>
				<Title order={4}>{creating ? '新建 KOOK Bot' : (settings?.id ?? '选择一个 Bot')}</Title>
				<Text size="sm" c="dimmed">
					{creating
						? '使用稳定的 Bot ID 区分社群或业务用途。'
						: status?.username
							? `${status.username} · KOOK ID ${status.botId}`
							: '保存凭据后将读取 Bot 身份。'}
				</Text>
			</Stack>
			{!creating && settings ? (
				<Badge size="lg" variant="light" color={phase.color}>
					{phase.label}
				</Badge>
			) : null}
		</Group>
	)
}

function Metric({
	label,
	value,
	icon,
	tone,
}: {
	label: string
	value: string
	icon?: ReactNode
	tone?: 'red'
}) {
	return (
		<Paper withBorder radius="sm" p="sm">
			<Group gap={6} c="dimmed" wrap="nowrap">
				{icon}
				<Text size="xs" truncate>
					{label}
				</Text>
			</Group>
			<Text fw={700} mt={4} c={tone}>
				{value}
			</Text>
		</Paper>
	)
}

function Diagnostic({
	label,
	value,
	warn = false,
}: {
	label: string
	value: ReactNode
	warn?: boolean
}) {
	return (
		<Box>
			<Text size="xs" c="dimmed">
				{label}
			</Text>
			<Text size="sm" fw={600} c={warn ? 'orange.7' : undefined}>
				{value}
			</Text>
		</Box>
	)
}

function nextAccountId(settings: readonly KookSettingsDoc[]): string {
	if (!settings.some((item) => item.id === 'default')) return 'default'
	let index = settings.length + 1
	while (settings.some((item) => item.id === `bot-${index}`)) index += 1
	return `bot-${index}`
}

function formatTime(value: number | null): string {
	if (!value) return '-'
	return new Intl.DateTimeFormat('zh-CN', {
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
	}).format(value)
}

function relativeTime(value: number | null): string {
	if (!value) return '暂无'
	const seconds = Math.max(0, Math.floor((Date.now() - value) / 1000))
	if (seconds < 60) return `${seconds} 秒前`
	if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
	if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
	return formatTime(value)
}

function durationSince(value: number | null): string {
	if (!value) return '-'
	const minutes = Math.max(0, Math.floor((Date.now() - value) / 60_000))
	if (minutes < 60) return `${minutes} 分钟`
	const hours = Math.floor(minutes / 60)
	return hours < 24 ? `${hours} 小时` : `${Math.floor(hours / 24)} 天`
}

function phaseOrder(status?: KookStatusDoc): number {
	if (status?.phase === 'error') return 0
	if (status?.phase === 'connecting') return 1
	if (status?.phase === 'online') return 2
	return 3
}
