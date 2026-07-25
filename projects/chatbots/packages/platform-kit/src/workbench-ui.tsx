import {
	Badge,
	Box,
	Button,
	Group,
	Paper,
	SimpleGrid,
	Stack,
	Text,
	TextInput,
	Title,
	UnstyledButton,
} from '@mantine/core'
import { useWorkbenchHost } from '@pluxel/runtime/workbench/ui'
import { useMemo, useState } from 'react'
import type { BotAdminAccount } from './bot-admin.ts'
import {
	EmptyAccounts,
	ManagerHeader,
	Metric,
	openAccountTab,
	openCreateTab,
	openManagerTab,
	PhaseBadge,
	phaseOrder,
	relativeTime,
	useAccounts,
	type BotAdminPanelProps,
} from './workbench-ui/shared.tsx'

export { BotAdminDetails } from './workbench-ui/BotAdminDetails.tsx'
export { Metric, relativeTime, durationSince } from './workbench-ui/shared.tsx'
export type {
	BotAdminDescriptor,
	BotAdminDetailsProps,
	BotAdminPanelProps,
} from './workbench-ui/shared.tsx'

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
