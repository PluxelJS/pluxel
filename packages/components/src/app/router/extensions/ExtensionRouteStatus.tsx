import { Alert, Badge, Button, Center, Group, Loader, Stack, Text } from '@mantine/core'
import { IconAlertTriangle, IconRefresh } from '@tabler/icons-react'
import { ErrorState } from '../../../components'
import {
	extensionInteractionLabel,
	extensionInteractionReasonLabel,
	usePluginUiStatus,
} from '../../../extension'

function fallbackMessage(pluginName: string): string {
	return `插件 ${pluginName} 的前端正在初始化，完成后会自动显示最新界面。`
}

function compileErrorMessage(pluginName: string, message?: string): string {
	if (message?.trim()) return message.trim()
	return `插件 ${pluginName} 的前端编译失败，修复后保存即可自动重试。`
}

function renderSyncMeta(updatedAt?: number) {
	if (!updatedAt) return null
	return (
		<Badge size="xs" variant="light" color="gray">
			{new Date(updatedAt).toLocaleTimeString()}
		</Badge>
	)
}

function ExtensionContributionStatusBanner({ pluginName }: { pluginName: string }) {
	const { diagnostics, summary, hasDiagnostics } = usePluginUiStatus(pluginName)
	if (!hasDiagnostics) return null

	const title = summary.issues.length > 0 ? '跨插件扩展存在待处理项' : '跨插件扩展已连接'
	const notableIssues = summary.issues.slice(0, 3)

	return (
		<Alert color={summary.tone} variant="light" radius="md" title={title}>
			<Stack gap={8}>
				<Text size="sm" c="dimmed">
					当前插件声明了 {diagnostics.surfaces.length} 个 surface、{diagnostics.offers.length} 个
					offer；收到 {summary.incomingActive.length} 个 active interaction，发出{' '}
					{summary.outgoingActive.length} 个 active interaction。
				</Text>
				<Group gap="xs">
					<Badge size="xs" variant="light" color="gray">
						surfaces {diagnostics.surfaces.length}
					</Badge>
					<Badge size="xs" variant="light" color="gray">
						offers {diagnostics.offers.length}
					</Badge>
					<Badge size="xs" variant="light" color="gray">
						sessions {diagnostics.sessions.length}
					</Badge>
					<Badge
						size="xs"
						variant="light"
						color={summary.incomingIssues.length > 0 ? 'yellow' : 'blue'}
					>
						incoming {diagnostics.incoming.length}
					</Badge>
					<Badge
						size="xs"
						variant="light"
						color={summary.outgoingIssues.length > 0 ? 'yellow' : 'blue'}
					>
						outgoing {diagnostics.outgoing.length}
					</Badge>
				</Group>
				{notableIssues.map((item) => (
					<Text
						key={`${item.targetPlugin ?? 'unknown'}:${item.surface ?? 'none'}:${item.offerId}:${item.state}`}
						size="sm"
					>
						{extensionInteractionLabel(item)}: {extensionInteractionReasonLabel(item.reason)}
					</Text>
				))}
			</Stack>
		</Alert>
	)
}

export function ExtensionRouteStateFallback({
	pluginName,
	routeVersion,
}: {
	pluginName: string
	routeVersion: number
}) {
	const { module: moduleState, retrySync } = usePluginUiStatus(pluginName)

	if (routeVersion > 0) return null

	if (moduleState?.state === 'error') {
		return (
			<ErrorState
				title="插件 UI 编译失败"
				message={compileErrorMessage(pluginName, moduleState.message)}
				onRetry={() => retrySync(true)}
				retryLabel="重新同步"
				withBorder
				minHeight="100%"
			/>
		)
	}

	const isBuilding = moduleState?.state === 'building'

	return (
		<Center style={{ flex: 1 }}>
			<Stack gap="xs" align="center">
				<Loader size="sm" />
				<Text fw={600}>{isBuilding ? '插件 UI 构建中' : '扩展模块加载中'}</Text>
				<Text c="dimmed" size="sm" ta="center">
					{isBuilding
						? `正在为 ${pluginName} 构建最新前端资源，完成后会自动热替换。`
						: fallbackMessage(pluginName)}
				</Text>
			</Stack>
		</Center>
	)
}

export function ExtensionRouteStatusBanner({ pluginName }: { pluginName: string }) {
	const { module: moduleState, retrySync } = usePluginUiStatus(pluginName)
	const contributionBanner = <ExtensionContributionStatusBanner pluginName={pluginName} />

	if (moduleState?.state === 'building') {
		return (
			<Stack gap="sm">
				<Alert
					color="yellow"
					variant="light"
					radius="md"
					title="插件 UI 正在热更新"
					icon={<Loader size={16} />}
				>
					<Stack gap={6}>
						<Text size="sm" c="dimmed">
							当前保留上一个可用版本，新的前端资源完成构建后会自动替换。
						</Text>
						<Group gap="xs">
							<Badge size="xs" variant="light" color="yellow">
								HMR
							</Badge>
							{renderSyncMeta(moduleState.updatedAt)}
						</Group>
					</Stack>
				</Alert>
				{contributionBanner}
			</Stack>
		)
	}

	if (moduleState?.state === 'error') {
		return (
			<Stack gap="sm">
				<Alert
					color="red"
					variant="light"
					radius="md"
					title="插件 UI 最新编译失败"
					icon={<IconAlertTriangle size={16} />}
				>
					<Stack gap={8}>
						<Text size="sm">{compileErrorMessage(pluginName, moduleState.message)}</Text>
						<Group gap="xs">
							{renderSyncMeta(moduleState.updatedAt)}
							<Button
								size="xs"
								variant="light"
								color="red"
								leftSection={<IconRefresh size={14} />}
								onClick={() => retrySync(true)}
							>
								重新同步
							</Button>
						</Group>
					</Stack>
				</Alert>
				{contributionBanner}
			</Stack>
		)
	}

	return contributionBanner
}
