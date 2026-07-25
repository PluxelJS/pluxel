import { Group, Paper, SimpleGrid, Stack, Text } from '@mantine/core'
import {
	BotAdminManager,
	BotAdminOverview,
	durationSince,
	Metric,
	relativeTime,
	type BotAdminDescriptor,
} from '@repo/chatbots-platform-kit/workbench-ui'
import { IconBrandDiscord } from '@tabler/icons-react'
import type { KookAdminAccount } from '../contract.ts'
import { kookUi } from './runtime.ts'

const GATEWAY_LABEL: Record<KookAdminAccount['diagnostics']['gatewayPhase'], string> = {
	idle: '待机',
	connecting: '连接中',
	resuming: '恢复会话',
	online: '在线',
	backoff: '退避中',
	stopped: '已停止',
}

const descriptor: BotAdminDescriptor<KookAdminAccount> = {
	name: 'KOOK',
	title: 'KOOK Bots',
	description: '管理多个 Bot 的凭据、Gateway 连接和运行健康度',
	defaultApiBase: 'https://www.kookapp.cn',
	color: 'violet.6',
	icon: <IconBrandDiscord size={28} />,
	connectHint: '保存后将立即启动 Gateway。Token 只写入 Pluxel Vault。',
	identity: (account) => account.username ?? account.identityId ?? '尚未鉴权',
	renderDiagnostics: (account) => (
		<Stack gap="sm">
			<SimpleGrid cols={{ base: 2, lg: 4 }} spacing="sm">
				<Metric label="Gateway" value={GATEWAY_LABEL[account.diagnostics.gatewayPhase]} />
				<Metric label="已确认序列" value={String(account.diagnostics.lastSequence)} />
				<Metric label="最近事件" value={relativeTime(account.diagnostics.lastEventAt)} />
				<Metric label="连接时长" value={durationSince(account.connectedAt)} />
			</SimpleGrid>
			<Paper withBorder radius="sm" p="md">
				<Group justify="space-between" mb="md">
					<Text fw={700}>Gateway 诊断</Text>
					<Text size="xs" c="dimmed">
						最后 Pong {relativeTime(account.diagnostics.lastPongAt)}
					</Text>
				</Group>
				<SimpleGrid cols={{ base: 2, sm: 3, lg: 4 }} spacing="md">
					<DiagnosticValue label="事件" value={account.diagnostics.eventsReceived} />
					<DiagnosticValue
						label="连接 / 重连"
						value={`${account.diagnostics.connectAttempts} / ${account.diagnostics.reconnectAttempts}`}
					/>
					<DiagnosticValue label="Resume" value={account.diagnostics.resumeAttempts} />
					<DiagnosticValue
						label="Ping / Pong"
						value={`${account.diagnostics.pingSent} / ${account.diagnostics.pongReceived}`}
					/>
					<DiagnosticValue label="当前缓冲" value={account.diagnostics.bufferedEvents} />
					<DiagnosticValue
						label="乱序 / 重复"
						value={`${account.diagnostics.outOfOrderEvents} / ${account.diagnostics.duplicateEvents}`}
					/>
					<DiagnosticValue
						label="缓冲溢出"
						value={account.diagnostics.bufferOverflows}
						tone={account.diagnostics.bufferOverflows > 0 ? 'red' : undefined}
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

export function KookOverviewPanel() {
	const { commands, state } = kookUi.useResources()
	return <BotAdminOverview commands={commands} state={state} descriptor={descriptor} />
}

export function KookManagerPanel() {
	const { commands, state } = kookUi.useResources()
	return <BotAdminManager commands={commands} state={state} descriptor={descriptor} />
}
