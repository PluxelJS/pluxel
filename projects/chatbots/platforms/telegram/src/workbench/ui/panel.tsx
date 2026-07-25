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
import { IconBrandTelegram } from '@tabler/icons-react'
import type { TelegramAdminAccount } from '../contract.ts'
import { telegramUi } from './runtime.ts'

const descriptor: BotAdminDescriptor<TelegramAdminAccount> = {
	name: 'Telegram',
	title: 'Telegram Bots',
	description: '管理多个 Bot 的凭据、Polling 连接和运行健康度',
	defaultApiBase: 'https://api.telegram.org',
	color: 'blue.6',
	icon: <IconBrandTelegram size={28} />,
	connectHint: '保存后将立即启动 long polling。Token 只写入 Pluxel Vault。',
	identity: (account) =>
		account.username ? `@${account.username}` : (account.identityId ?? '尚未鉴权'),
	renderDiagnostics: (account) => (
		<Stack gap="sm">
			<SimpleGrid cols={{ base: 2, lg: 4 }} spacing="sm">
				<Metric label="Polling offset" value={String(account.diagnostics.offset)} />
				<Metric label="最近更新 ID" value={String(account.diagnostics.lastUpdateId ?? '-')} />
				<Metric label="最近更新" value={relativeTime(account.diagnostics.lastUpdateAt)} />
				<Metric label="连接时长" value={durationSince(account.connectedAt)} />
			</SimpleGrid>
			<Paper withBorder radius="sm" p="md">
				<Group justify="space-between" mb="md">
					<Text fw={700}>Polling 诊断</Text>
					<Text size="xs" c="dimmed">
						最近请求 {relativeTime(account.diagnostics.lastPollAt)}
					</Text>
				</Group>
				<SimpleGrid cols={{ base: 2, sm: 3 }} spacing="md">
					<DiagnosticValue label="当前 offset" value={account.diagnostics.offset} />
					<DiagnosticValue
						label="连续失败"
						value={account.diagnostics.consecutiveFailures}
						tone={account.diagnostics.consecutiveFailures > 0 ? 'red' : undefined}
					/>
					<DiagnosticValue
						label="当前退避"
						value={
							account.diagnostics.currentBackoffMs
								? `${account.diagnostics.currentBackoffMs} ms`
								: '-'
						}
						tone={account.diagnostics.currentBackoffMs > 0 ? 'red' : undefined}
					/>
				</SimpleGrid>
			</Paper>
		</Stack>
	),
}

function DiagnosticValue({
	label,
	value,
	tone,
}: {
	label: string
	value: string | number
	tone?: 'red'
}) {
	return (
		<Stack gap={2}>
			<Text size="xs" c="dimmed">
				{label}
			</Text>
			<Text fw={700} c={tone}>
				{value}
			</Text>
		</Stack>
	)
}

export function TelegramOverviewPanel() {
	const { commands, state } = telegramUi.useResources()
	return <BotAdminOverview commands={commands} state={state} descriptor={descriptor} />
}

export function TelegramManagerPanel() {
	const { commands, state } = telegramUi.useResources()
	return <BotAdminLauncher commands={commands} state={state} descriptor={descriptor} />
}

export function TelegramAccountPanel() {
	const { commands, state } = telegramUi.useResources()
	return (
		<BotAdminDetails commands={commands} state={state} descriptor={descriptor} mode="account" />
	)
}

export function TelegramCreatePanel() {
	const { commands, state } = telegramUi.useResources()
	return <BotAdminDetails commands={commands} state={state} descriptor={descriptor} mode="create" />
}
