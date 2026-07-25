import { Badge, Box, Group, Paper, Stack, Text, Title } from '@mantine/core'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { useEffect, useState, type ReactNode } from 'react'
import type { BotAdminAccount, BotAdminCommands, BotAdminEvents } from '../bot-admin.ts'

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

export function useAccounts<Account extends BotAdminAccount<object>>(state: EventClient<Account>) {
	const [accounts, setAccounts] = useState<readonly Account[]>([])
	const connection = state.useConnectionState().state
	useEffect(
		() => state.subscribe('snapshot', (snapshot) => setAccounts(snapshot.accounts)),
		[state],
	)
	return { accounts, connected: connection === 'connected' }
}

export function ManagerHeader<Account extends BotAdminAccount<object>>({
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

export function EmptyAccounts<Account extends BotAdminAccount<object>>({
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

export function openManagerTab(
	host: ReturnType<typeof useWorkbenchHost>,
	descriptor: BotAdminDescriptor<BotAdminAccount<object>>,
) {
	host.openTab({ path: '/settings', title: descriptor.title, meta: 'Bots' })
}

export function openCreateTab(
	host: ReturnType<typeof useWorkbenchHost>,
	descriptor: BotAdminDescriptor<BotAdminAccount<object>>,
) {
	host.openTab({ path: '/create', title: `新建 ${descriptor.name} Bot`, meta: descriptor.name })
}

export function openAccountTab(
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

export function PhaseBadge({ phase }: { phase: keyof typeof PHASE }) {
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

export function phaseOrder(account: BotAdminAccount<object>): number {
	if (account.phase === 'error') return 0
	if (account.phase === 'connecting') return 1
	if (account.phase === 'online') return 2
	return 3
}
