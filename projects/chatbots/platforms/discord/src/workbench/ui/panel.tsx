import { Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core'
import {
	BotAdminDetails,
	BotAdminLauncher,
	BotAdminOverview,
	durationSince,
	Metric,
	relativeTime,
	type BotAdminDescriptor,
} from '@repo/chatbots-platform-kit/workbench-ui'
import { IconBrandDiscord } from '@tabler/icons-react'
import type { DiscordAdminAccount } from '../contract.ts'
import { discordUi } from './runtime.ts'

const descriptor: BotAdminDescriptor<DiscordAdminAccount> = {
	name: 'Discord',
	title: 'Discord Bots',
	description: '管理多个 Bot 的凭据、Gateway 连接和运行健康度',
	defaultApiBase: 'https://discord.com/api/v10',
	color: 'indigo.6',
	icon: <IconBrandDiscord size={28} />,
	connectHint: '保存后将立即启动 Gateway。Token 只写入 Pluxel Vault。',
	identity: (account) => account.username ?? account.identityId ?? '尚未鉴权',
	renderDiagnostics: (account) => (
		<Stack gap="sm">
			<SimpleGrid cols={{ base: 2, lg: 4 }} spacing="sm">
				<Metric label="服务器" value={String(account.diagnostics.guilds)} />
				<Metric label="连接代次" value={String(account.diagnostics.epoch)} />
				<Metric label="最近健康" value={relativeTime(account.diagnostics.lastHealthyAt)} />
				<Metric label="连接时长" value={durationSince(account.connectedAt)} />
			</SimpleGrid>
			<Paper withBorder radius="sm" p="md">
				<Group justify="space-between">
					<Text fw={700}>Gateway 诊断</Text>
					<Text size="xs" c="dimmed">
						Application {account.diagnostics.applicationId ?? '尚未取得'}
					</Text>
				</Group>
			</Paper>
		</Stack>
	),
}

export function DiscordOverviewPanel() {
	const { commands, state } = discordUi.useResources()
	return <BotAdminOverview commands={commands} state={state} descriptor={descriptor} />
}

export function DiscordManagerPanel() {
	const { commands, state } = discordUi.useResources()
	return <BotAdminLauncher commands={commands} state={state} descriptor={descriptor} />
}

export function DiscordAccountPanel() {
	const { commands, state } = discordUi.useResources()
	return (
		<BotAdminDetails commands={commands} state={state} descriptor={descriptor} mode="account" />
	)
}

export function DiscordCreatePanel() {
	const { commands, state } = discordUi.useResources()
	return <BotAdminDetails commands={commands} state={state} descriptor={descriptor} mode="create" />
}
